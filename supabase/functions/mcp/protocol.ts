import type { VerifiedMcpToken } from "./auth.ts";
// @ts-ignore TS5097: the Deno edge graph requires the real .ts path.
import { presentsAdminCredential } from "../_shared/admin-credential-boundary.ts";
// @ts-ignore TS5097: the Deno edge graph requires the real .ts path.
import { HOSTED_TOOL_TABLE, HostedToolInputError, hostedToolName, type HostedToolExecutor, validateHostedToolArguments } from "./tools.ts";

export const PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/mcp";
export const RESOURCE_METADATA_URL =
  `https://mcp.commonswarm.com${PROTECTED_RESOURCE_METADATA_PATH}`;
export const WWW_AUTHENTICATE =
  `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`;
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18"] as const;

const INTERNAL_METADATA_PATH = `/mcp${PROTECTED_RESOURCE_METADATA_PATH}`;
const REQUEST_NODE_LIMIT = 1_000;
const REQUEST_DEPTH_LIMIT = 32;

export interface McpProtocolLimits {
  maxBodyBytes: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  maxConcurrentRequests: number;
}

export interface McpProtocolOptions {
  issuer: string;
  resource: string;
  publicEnabled: boolean;
  allowedOrigins: ReadonlySet<string>;
  limits: McpProtocolLimits;
  verifyToken: (token: string, signal: AbortSignal) => Promise<VerifiedMcpToken>;
  executeTool: HostedToolExecutor;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function json(status: number, value: unknown, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...Object.fromEntries(new Headers(extra)),
    },
  });
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function boundedJsonTree(value: unknown): boolean {
  let nodes = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const next = pending.pop()!;
    nodes += 1;
    if (nodes > REQUEST_NODE_LIMIT || next.depth > REQUEST_DEPTH_LIMIT) return false;
    if (Array.isArray(next.value)) {
      for (const item of next.value) pending.push({ value: item, depth: next.depth + 1 });
    } else {
      const row = record(next.value);
      if (row !== null) {
        for (const item of Object.values(row)) pending.push({ value: item, depth: next.depth + 1 });
      }
    }
  }
  return true;
}

async function readBody(request: Request, maximum: number, signal: AbortSignal): Promise<string> {
  const announced = request.headers.get("content-length");
  if (announced !== null && (!/^\d+$/u.test(announced) || Number(announced) > maximum)) {
    throw new RangeError("body_too_large");
  }
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new RangeError("body_too_large");
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyntaxError("invalid_utf8");
  }
}

function parsedRpc(value: unknown): JsonRpcRequest | null {
  const row = record(value);
  if (row === null || row.jsonrpc !== "2.0" || typeof row.method !== "string" ||
      row.method.length < 1 || row.method.length > 128 ||
      Object.keys(row).some((key) => !["jsonrpc", "id", "method", "params"].includes(key)) ||
      (row.id !== undefined &&
        !(typeof row.id === "string" && row.id.length <= 256) &&
        !(typeof row.id === "number" && Number.isSafeInteger(row.id))) ||
      (row.params !== undefined && record(row.params) === null)) return null;
  return row as unknown as JsonRpcRequest;
}

function bearer(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (value === null) return null;
  const match = /^Bearer ([A-Za-z0-9._-]+)$/u.exec(value);
  return match?.[1] ?? null;
}

function requestSignal(request: Request, timeoutMs: number): {
  signal: AbortSignal;
  close: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("request_timeout")), timeoutMs);
  const abort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abort();
  else request.signal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
    },
  };
}

async function beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function protectedResourceMetadata(issuer: string, resource: string) {
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
    resource_name: "CommonSwarm hosted MCP",
  };
}

export function createMcpProtocolHandler(options: McpProtocolOptions) {
  let concurrent = 0;
  return async function handleRequest(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const metadata = pathname === PROTECTED_RESOURCE_METADATA_PATH ||
      pathname === INTERNAL_METADATA_PATH;
    if ((pathname === "/mcp" || metadata) && !options.publicEnabled) {
      return json(503, {
        error: "feature_disabled",
        feature: "hosted_mcp",
        message: "Hosted MCP is not available yet.",
      });
    }
    if (metadata) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
      }
      const response = json(200, protectedResourceMetadata(options.issuer, options.resource));
      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }
    if (pathname !== "/mcp") return json(404, { error: "not_found" });
    if (presentsAdminCredential(request)) {
      return json(401, { error: "unauthorized" }, { "www-authenticate": WWW_AUTHENTICATE });
    }
    if (request.method !== "POST") {
      return json(405, { error: "method_not_allowed" }, { allow: "POST" });
    }
    const origin = request.headers.get("origin");
    if (origin !== null && !options.allowedOrigins.has(origin)) {
      return json(403, { error: "origin_not_allowed" });
    }
    if (concurrent >= options.limits.maxConcurrentRequests) {
      return json(429, { error: "too_many_requests" }, { "retry-after": "1" });
    }
    const token = bearer(request);
    if (token === null) {
      return json(401, { error: "unauthorized" }, { "www-authenticate": WWW_AUTHENTICATE });
    }
    concurrent += 1;
    const lifetime = requestSignal(request, options.limits.requestTimeoutMs);
    let toolOperation: Promise<Record<string, unknown>> | null = null;
    let toolSettled = false;
    try {
      let verified: VerifiedMcpToken;
      try {
        verified = await beforeAbort(options.verifyToken(token, lifetime.signal), lifetime.signal);
      } catch {
        return json(401, { error: "unauthorized" }, { "www-authenticate": WWW_AUTHENTICATE });
      }
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return json(415, { error: "unsupported_media_type" });
      }
      let value: unknown;
      try {
        const source = await readBody(request, options.limits.maxBodyBytes, lifetime.signal);
        value = JSON.parse(source);
      } catch (error) {
        if (error instanceof RangeError) return json(413, { error: "request_too_large" });
        if (lifetime.signal.aborted) return json(504, { error: "request_timeout" });
        return json(400, rpcError(null, -32700, "Parse error"));
      }
      if (!boundedJsonTree(value)) return json(400, rpcError(null, -32600, "Invalid Request"));
      const message = parsedRpc(value);
      if (message === null) return json(400, rpcError(null, -32600, "Invalid Request"));
      const protocolHeader = request.headers.get("mcp-protocol-version");
      if (protocolHeader !== null &&
          !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolHeader as typeof SUPPORTED_PROTOCOL_VERSIONS[number])) {
        return json(400, rpcError(message.id ?? null, -32600, "Unsupported protocol version"));
      }
      if (message.method === "notifications/initialized") {
        return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
      }
      if (message.id === undefined) return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
      let result: unknown;
      if (message.method === "initialize") {
        const requested = message.params?.protocolVersion;
        if (typeof requested !== "string" ||
            !SUPPORTED_PROTOCOL_VERSIONS.includes(requested as typeof SUPPORTED_PROTOCOL_VERSIONS[number])) {
          return json(400, rpcError(message.id, -32602, "Unsupported protocol version"));
        }
        result = {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "commonswarm", version: "1.0.0" },
          instructions: "Use an explicit seat handle for every CommonSwarm tool call.",
        };
      } else if (message.method === "ping") {
        result = {};
      } else if (message.method === "tools/list") {
        if (message.params !== undefined && Object.keys(message.params).length !== 0) {
          return json(400, rpcError(message.id, -32602, "Invalid params"));
        }
        result = { tools: HOSTED_TOOL_TABLE };
      } else if (message.method === "tools/call") {
        const params = message.params;
        if (params === undefined || Object.keys(params).some((key) => !["name", "arguments"].includes(key)) ||
            typeof params.name !== "string" || !hostedToolName(params.name)) {
          return json(400, rpcError(message.id, -32602, "Invalid params"));
        }
        try {
          const args = validateHostedToolArguments(params.name, params.arguments ?? {});
          toolOperation = options.executeTool({
            name: params.name,
            arguments: args,
            token: verified,
            signal: lifetime.signal,
          });
          void toolOperation.then(
            () => { toolSettled = true; },
            () => { toolSettled = true; },
          );
          const output = await beforeAbort(toolOperation, lifetime.signal);
          result = { content: [{ type: "text", text: JSON.stringify(output) }] };
        } catch (error) {
          if (lifetime.signal.aborted) return json(504, { error: "request_timeout" });
          if (error instanceof HostedToolInputError) {
            return json(400, rpcError(message.id, -32602, error.message));
          }
          const code = error instanceof Error && /^hosted_[a-z0-9_]+$/u.test(error.message)
            ? error.message
            : "tool_failed";
          result = {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ error: code }) }],
          };
        }
      } else {
        return json(404, rpcError(message.id, -32601, "Method not found"));
      }
      const envelope = { jsonrpc: "2.0", id: message.id, result };
      const encoded = JSON.stringify(envelope);
      if (new TextEncoder().encode(encoded).byteLength > options.limits.maxResponseBytes) {
        return json(500, rpcError(message.id, -32603, "Response exceeds limit"));
      }
      return new Response(encoded, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } catch {
      return lifetime.signal.aborted
        ? json(504, { error: "request_timeout" })
        : json(500, { error: "internal_error" });
    } finally {
      lifetime.close();
      if (toolOperation !== null && !toolSettled) {
        // A timed-out database operation may not observe AbortSignal. Keep its
        // concurrency slot until it really settles instead of admitting work
        // behind a success-shaped timeout response.
        void toolOperation.then(
          () => { concurrent -= 1; },
          () => { concurrent -= 1; },
        );
      } else {
        concurrent -= 1;
      }
    }
  };
}

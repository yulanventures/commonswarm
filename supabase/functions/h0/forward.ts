/** H0's thin HTTP adapter to the command edge. Authority stays in command/index.ts. */
import postgres from "npm:postgres@3.4.9";
import { withDatabaseTls } from "../_shared/database-options.ts";
import { CLIENT_PROTOCOL_VERSION } from "../../../src/cloud/config.ts";
import { H0_CACHE_CONTROL, H0_ROBOTS_TAG } from "./core.ts";
import {
  H0_BEARER_QUERY_REFUSED,
  H0_BEARER_QUERY_REFUSED_MESSAGE,
  H0_INVALID_REQUEST,
  h0BearerInQuery,
  parseH0ForwardBody,
  type H0ForwardVerb,
} from "./parse.ts";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_COMMAND_RESPONSE_BYTES = 128 * 1024;
const AGENT_TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^Bearer +([^\s]+)$/i;
let database: postgres.Sql | null = null;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": H0_CACHE_CONTROL,
      "x-robots-tag": H0_ROBOTS_TAG,
    },
  });
}

function unreadable(): Response {
  return json(502, { error: "h0_command_unreadable" });
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let count = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    count += value.byteLength;
    if (count > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function h0Database(): postgres.Sql {
  if (database !== null) return database;
  const url = Deno.env.get("SWARM_DATABASE_URL") ?? Deno.env.get("SUPABASE_DB_URL");
  if (!url) throw new Error("h0 forwarding requires a database URL");
  database = postgres(url, withDatabaseTls({
    max: 1, prepare: false, idle_timeout: 3, connect_timeout: 10,
  }, Deno.env.get("SWARM_DATABASE_TLS_CA_B64")));
  return database;
}

/** Routing hint only; the command edge authenticates and checks it again. */
async function workspaceForToken(token: string | null): Promise<string> {
  if (token === null || !AGENT_TOKEN_RE.test(token)) return crypto.randomUUID();
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  const rows = await h0Database()<[{ workspace_id: string }]>`
    SELECT p.workspace_id::text
    FROM swarm.agent_tokens AS t
    JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
    WHERE t.token_hash = ${hash}
    LIMIT 1
  `;
  return rows[0]?.workspace_id ?? crypto.randomUUID();
}

async function commandResponse(response: Response, verb: H0ForwardVerb): Promise<Response> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_COMMAND_RESPONSE_BYTES) return unreadable();
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return unreadable();
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_COMMAND_RESPONSE_BYTES) return unreadable();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return unreadable();
  }
  if (body === null || typeof body !== "object" || Array.isArray(body) ||
    (verb !== "register" && Object.hasOwn(body, "agent_token"))) {
    return unreadable();
  }
  return new Response(raw, {
    status: response.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": H0_CACHE_CONTROL,
      "x-robots-tag": H0_ROBOTS_TAG,
    },
  });
}

export async function handleH0ForwardRequest(
  request: Request,
  verb: H0ForwardVerb,
): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const url = new URL(request.url);
  if (h0BearerInQuery(url)) {
    return json(400, {
      error: H0_BEARER_QUERY_REFUSED,
      message: H0_BEARER_QUERY_REFUSED_MESSAGE,
    });
  }
  const parsed = parseH0ForwardBody(verb, await readJson(request));
  if (!parsed.ok) return json(400, { error: parsed.error, message: parsed.message });
  const body = parsed.body;
  const presented = request.headers.get("authorization");
  const token = presented === null ? null : BEARER_RE.exec(presented)?.[1] ?? null;
  const credential = verb === "register" ? body.joinCredential as string : token;
  const workspaceId = verb === "register"
    ? crypto.randomUUID()
    : await workspaceForToken(token);
  const command = verb === "register"
    ? { kind: "register_agent_seat", attempt_id: body.attemptId, name: body.name }
    : {
      kind: "post_signal",
      signal_kind: verb === "reply" ? "note" : verb,
      body: body.body,
      to_user_id: null,
      to_agent_principal_id: null,
      in_reply_to: verb === "reply" ? body.signal_id : null,
      about: null,
      ...(Object.hasOwn(body, "to") ? { to: body.to } : {}),
    };
  const commandId = verb === "register"
    ? crypto.randomUUID()
    : typeof body.requestId === "string" ? body.requestId : crypto.randomUUID();
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) return unreadable();
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/functions/v1/command", base), {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
      },
      body: JSON.stringify({
        command_id: commandId,
        client_version: CLIENT_PROTOCOL_VERSION,
        workspace_id: workspaceId,
        stream: { kind: "workspace" },
        command,
      }),
      signal: request.signal,
    });
  } catch {
    return unreadable();
  }
  return await commandResponse(upstream, verb);
}

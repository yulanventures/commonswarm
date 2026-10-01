import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { createPool, loadConfig } from "./config.js";
import { ClientError } from "./client-error.js";
import { createConsentOrchestrator, createPostgresConsentProgress } from "./consent.js";
import { createGoTrueClient } from "./gotrue.js";
import { InteractionStore } from "./interaction-store.js";
import { createInteractionHandler } from "./interactions.js";
import { createLogger } from "./logger.js";
import { createPinnedMetadataFetch, createPostgresCimdFetch } from "./metadata-fetch.js";
import { createPostgresAdapter } from "./postgres-adapter.js";
import { createMcpProvider } from "./provider.js";
import { createProductionManagementBindings } from "./management-bindings.js";

const ALWAYS_AVAILABLE = new Set([
  "/health",
  "/jwks",
  "/.well-known/openid-configuration",
  "/.well-known/oauth-authorization-server",
]);

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
}

function rejectOversizedRequest(request, response) {
  if (response.headersSent) {
    request.destroy();
    return;
  }
  request.pause();
  response.shouldKeepAlive = false;
  if (typeof response.once === "function") response.once("finish", () => request.destroy());
  json(response, 413, { error: "request_too_large" }, { connection: "close" });
  if (typeof response.once !== "function") request.destroy();
}

function clientErrorResponse(error) {
  if (!(error instanceof ClientError)) return null;
  return {
    status: error.status,
    body: { error: error.code },
  };
}

export function createHandler({ provider, pool, publicAuthorizationEnabled, maxBodyBytes, logger,
  interactionHandler }) {
  const oidc = provider.callback();
  return async function handle(request, response) {
    const requestId = randomUUID();
    const started = Date.now();
    const path = new URL(request.url, "https://mcp.commonswarm.com").pathname;
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    try {
      const contentLength = Number(request.headers["content-length"] ?? 0);
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxBodyBytes) {
        rejectOversizedRequest(request, response);
        return;
      }
      const interactionReadsBody = request.method === "POST" &&
        /^\/interaction\/[^/]+\/(?:selection|consent)$/u.test(path);
      if (!interactionReadsBody) {
        let streamedBytes = 0;
        request.on("data", (chunk) => {
          streamedBytes += chunk.length;
          if (streamedBytes > maxBodyBytes) rejectOversizedRequest(request, response);
        });
      }
      if (path === "/health") {
        const check = await pool.query(
          "SELECT to_regclass('commonswarm_oauth.provider_artifacts') IS NOT NULL AS healthy",
        );
        json(response, check.rows[0]?.healthy === true || check.rows[0]?.healthy === 1 ? 200 : 503, {
          status: check.rows[0]?.healthy === true || check.rows[0]?.healthy === 1 ? "ok" : "unavailable",
        });
        return;
      }
      if (!publicAuthorizationEnabled && !ALWAYS_AVAILABLE.has(path)) {
        json(response, 503, { error: "authorization_service_disabled" });
        return;
      }
      if (interactionHandler && await interactionHandler(request, response,
        new URL(request.url, "https://mcp.commonswarm.com"))) return;
      await oidc(request, response);
    } catch (error) {
      const clientResponse = clientErrorResponse(error);
      const status = clientResponse?.status ?? 500;
      logger.info({ event: "request_failed", request_id: requestId, method: request.method,
        path, status, error_code: clientResponse?.body.error ?? error?.code ?? "internal_error" });
      if (!response.headersSent) {
        json(response, status, clientResponse?.body ?? { error: "internal_error", request_id: requestId });
      }
      else response.end();
    } finally {
      logger.info({ event: "request_complete", request_id: requestId, method: request.method,
        path, status: response.statusCode, duration_ms: Date.now() - started });
    }
  };
}

export function createProductionFindAccount(pool) {
  return async function findAccount(ctx, accountId, source) {
    const refreshGrantId = ctx?.oidc?.params?.grant_type === "refresh_token" &&
      typeof source?.grantId === "string" ? source.grantId : null;
    if (refreshGrantId !== null) {
      const result = await pool.query(
        `SELECT 1
           FROM commonswarm_oauth.resolve_hosted_grant_status($1) AS status
          WHERE status.owner_user_id = $2::uuid AND status.active
          LIMIT 1`,
        [refreshGrantId, accountId],
      );
      return result.rowCount === 1 ? {
        accountId,
        claims: async () => ({ sub: accountId }),
      } : undefined;
    }
    const result = await pool.query(
      `SELECT 1 FROM commonswarm_oauth.browser_sessions
        WHERE user_id = $1::uuid AND authenticated_at IS NOT NULL
          AND invalidated_at IS NULL AND expires_at > statement_timestamp()
        LIMIT 1`,
      [accountId],
    );
    return result.rowCount === 1 ? {
      accountId,
      claims: async () => ({ sub: accountId }),
    } : undefined;
  };
}

export async function startServer({
  env = process.env,
  config,
  writeLog,
  managementCommand,
  managementWorkspaceReader,
} = {}) {
  config ??= await loadConfig(env);
  if (config.publicAuthorizationEnabled &&
      (typeof managementCommand !== "function" || typeof managementWorkspaceReader !== "function")) {
    throw new Error("public authorization requires lane-2 management command and workspace-read bindings");
  }
  const pool = createPool(config);
  const metadataFetch = createPostgresCimdFetch(pool, createPinnedMetadataFetch());
  const provider = await createMcpProvider({
    adapter: createPostgresAdapter(pool),
    cookieKeys: config.cookieKeys,
    jwks: config.jwks,
    authorizationCodeTtlSeconds: config.authorizationCodeTtlSeconds,
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
    nativeLoopbackEnabled: config.nativeLoopbackEnabled,
    metadataFetch,
    providerGrantActive: async (grantId) => {
      const result = await pool.query(
        `SELECT active
           FROM commonswarm_oauth.resolve_hosted_grant_status($1)
          LIMIT 1`,
        [grantId],
      );
      return result.rows[0]?.active === true;
    },
    clientMetadataAccepted: async (metadata) => {
      const canonical = JSON.stringify(metadata);
      await pool.query(
        `INSERT INTO commonswarm_oauth.cimd_cache
          (client_id, metadata, metadata_digest, validated_at, expires_at)
         VALUES ($1, $2::jsonb, $3, statement_timestamp(),
                 statement_timestamp() + interval '5 minutes')
         ON CONFLICT (client_id) DO UPDATE SET
           metadata = EXCLUDED.metadata,
           metadata_digest = EXCLUDED.metadata_digest,
           validated_at = EXCLUDED.validated_at,
           expires_at = EXCLUDED.expires_at
         WHERE commonswarm_oauth.cimd_cache.expires_at <= statement_timestamp()`,
        [metadata.client_id, canonical, createHash("sha256").update(canonical).digest()],
      );
      return true;
    },
    findAccount: createProductionFindAccount(pool),
  });
  const logger = createLogger(writeLog);
  const interactionHandler = config.publicAuthorizationEnabled
    ? createInteractionHandler({
        provider,
        store: new InteractionStore(pool),
        gotrue: createGoTrueClient({
          baseUrl: config.gotrueUrl,
          anonKey: config.supabaseAnonKey,
          provider: config.gotrueProvider,
        }),
        consentOrchestrator: createConsentOrchestrator({
          command: managementCommand,
          progress: createPostgresConsentProgress(pool),
        }),
        workspaceReader: managementWorkspaceReader,
        allowedOrigins: config.allowedOrigins,
        callbackUrl: `${config.issuer}/oauth/callback/gotrue`,
        maxBodyBytes: config.maxBodyBytes,
        bodyReadTimeoutMs: config.requestTimeoutMs,
      })
    : undefined;
  const server = createServer(createHandler({ provider, pool, logger, interactionHandler, ...config }));
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs, 10_000);
  server.maxHeadersCount = 64;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", resolve);
  });
  return { server, provider, pool };
}

// Both npm start and the Docker CMD reach this production composition root.
export async function startProductionServer() {
  const config = await loadConfig();
  const bindings = await createProductionManagementBindings(config);
  try {
    const running = await startServer({ config, ...bindings });
    running.server.once("close", () => { void bindings.closeManagement?.(); });
    return running;
  } catch (error) {
    await bindings.closeManagement?.();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startProductionServer().catch((error) => {
    process.stderr.write(`mcp-auth failed to start (${error?.code ?? "configuration_error"})\n`);
    process.exitCode = 1;
  });
}

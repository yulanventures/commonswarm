// OAuth HTTP composition: validated config/requests in, gated responses out.
// Finish routes precede normal binding/provider dispatch; P9b owns their CSP.
// GoTrue uses runtimePool, never the admin wrapper; finish verifies live binding.
import { Pool } from "pg";
import { adminQuery, adminTransactionContext, withAdminRole } from "./admin-transaction.js";
import { createAdminHttpHandler } from "./admin-http.js";
import { oauthErrorResponse } from "./admin-oauth-error.js";
import { createAdminGateHandler } from "./admin-gate.js";
import { AdminTokenLifecycle } from "./admin-lifecycle.js";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createPool, DcrLimitConfigurationError, loadConfig } from "./config.js";
import { ClientError, InteractionStateError } from "./client-error.js";
import { INTERACTION_SECURITY_HEADERS } from "./browser-security.js";
import { createConsentOrchestrator, createPostgresConsentProgress } from "./consent.js";
import { createGoTrueClient, readGoTrueSession } from "./gotrue.js";
import { createFinishFlow } from "./finish-flow.js";
import { FINISH_TIMER_PATH } from "./finish-page.js";
import { FinishStore } from "./finish-store.js";
import { CONSENT_SUBMIT_PATH, renderDifferentAccountPage, renderConsentResultPage } from "./interaction-page.js";
import { InteractionStore } from "./interaction-store.js";
import { createInteractionHandler } from "./interactions.js";
import { createAdminConsentService, PostgresAdminConsentStore } from "./admin-consent.js";
import { createAdminInteractionHandler, createResourceInteractionHandler } from "./admin-interactions.js";
import { createLogger, logProviderError, subscribeProviderErrors } from "./logger.js";
import { createPinnedMetadataFetch, createPostgresCimdFetch } from "./metadata-fetch.js";
import { createPostgresAdapter } from "./postgres-adapter.js";
import { createMcpProvider, RESOURCE } from "./provider.js";
import { createProductionManagementBindings } from "./management-bindings.js";
import { CLIENT_SCOPES, createPostgresRegistrationStore, createRegistrationLimiter } from "./registration.js";

const ALWAYS_AVAILABLE = new Set([
  "/health",
  "/jwks",
  "/.well-known/openid-configuration",
  "/.well-known/oauth-authorization-server",
]);
const CONSENT_SUBMIT_SCRIPT = readFileSync(new URL("./consent-submit.js", import.meta.url));
const FINISH_TIMER_SCRIPT = readFileSync(new URL("./finish-timer.js", import.meta.url));

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
  const oauth = oauthErrorResponse(error);
  if (oauth) return oauth;
  if (!(error instanceof ClientError) && !(error instanceof InteractionStateError)) return null;
  return {
    status: error.status,
    body: { error: error.code },
  };
}

// Ask the provider for genuine consent before its offline_access scope filter.
// Ambiguous or unsupported requests must reach the provider unchanged.
function initialConsentLocation(request) {
  if (request.method !== "GET") return null;
  const url = new URL(request.url, "https://mcp.commonswarm.com");
  if (url.pathname !== "/authorize") return null;
  try { decodeURIComponent(url.search.slice(1).replace(/\+/gu, " ")); }
  catch { return null; }
  const params = url.searchParams;
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1) ||
      params.has("request") || params.has("request_uri") ||
      params.get("resource") !== RESOURCE || params.get("response_type") !== "code") return null;
  const scope = params.get("scope") ?? "";
  if (!/^[a-z_]+(?: [a-z_]+)*$/u.test(scope)) return null;
  const scopes = scope.split(" ");
  if (!scopes.includes("mcp") || !scopes.includes("offline_access") ||
      scopes.some((value) => !CLIENT_SCOPES.includes(value))) return null;
  const prompt = params.get("prompt");
  if (prompt !== null && !/^(?:login|select_account)(?: (?:login|select_account))*$/u.test(prompt)) return null;
  if (prompt !== null && new Set(prompt.split(" ")).size !== prompt.split(" ").length) return null;
  params.set("prompt", prompt === null ? "consent" : `${prompt} consent`);
  return `/authorize?${params}`;
}

export function createHandler({ provider, pool, publicAuthorizationEnabled, maxBodyBytes, logger,
  finishEnabled = false, finishFlow,
  interactionHandler, adminGateHandler = createAdminGateHandler({}) }) {
  subscribeProviderErrors(provider, logger);
  const oidc = provider.callback();
  return async function handle(request, response) {
    const requestId = randomUUID();
    const started = Date.now();
    const path = new URL(request.url, "https://mcp.commonswarm.com").pathname;
    const finishRoute = finishEnabled && /^\/interaction\/[^/]+\/(connected|finish)$/u.test(path);
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    try {
      if (path === "/admin/gate") return await adminGateHandler(request, response);
      const contentLength = Number(request.headers["content-length"] ?? 0);
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maxBodyBytes) {
        rejectOversizedRequest(request, response);
        return;
      }
      const interactionReadsBody = request.method === "POST" &&
        /^\/interaction\/[^/]+\/(?:selection|consent|switch-account)$/u.test(path);
      if (!interactionReadsBody) {
        // Observe bytes only when the route's reader pulls them. Adding a data
        // listener to an unpaused IncomingMessage starts flowing and can discard
        // buffered bytes during the await before the provider installs its parser.
        request.pause();
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
      const consentLocation = initialConsentLocation(request);
      if (consentLocation !== null) {
        response.writeHead(303, { location: consentLocation, "cache-control": "no-store",
          "referrer-policy": "no-referrer" });
        response.end();
        return;
      }
      // The timer is a preloaded asset; only P9b sets a document CSP.
      if (finishRoute || finishEnabled && path === FINISH_TIMER_PATH) {
        response.setHeader("referrer-policy", "no-referrer");
        response.setHeader("x-content-type-options", "nosniff");
        if (path === FINISH_TIMER_PATH) {
          if (request.method !== "GET" && request.method !== "HEAD") {
            json(response, 405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
          } else {
            response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
            response.end(request.method === "HEAD" ? undefined : FINISH_TIMER_SCRIPT);
          }
          return;
        }
        if (!finishFlow) {
          json(response, 503, { error: "finish_service_unavailable" });
          return;
        }
        if (await finishFlow.handle(request, response, new URL(request.url, provider.issuer))) return;
      }
      if (path === CONSENT_SUBMIT_PATH) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          json(response, 405, { error: "method_not_allowed" }, { allow: "GET, HEAD" });
          return;
        }
        response.writeHead(200, { ...INTERACTION_SECURITY_HEADERS,
          "content-type": "text/javascript; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : CONSENT_SUBMIT_SCRIPT);
        return;
      }
      if (interactionHandler && await interactionHandler(request, response,
        new URL(request.url, "https://mcp.commonswarm.com"))) return;
      await oidc(request, response);
    } catch (error) {
      if (path.startsWith("/interaction/") || path === "/oauth/callback/gotrue") {
        logProviderError(logger, "interaction.error", requestId, error);
      }
      const clientResponse = clientErrorResponse(error);
      const status = clientResponse?.status ?? 500;
      logger.info({ event: "request_failed", request_id: requestId, method: request.method,
        path, status, error_code: clientResponse?.body.error ?? error?.code ?? "internal_error" });
      if (!response.headersSent) {
        if (!finishRoute && error instanceof InteractionStateError && (request.method === "GET" ||
            error.code === "different_account" || error.code === "interaction_binding_mismatch" ||
            error.code === "interaction_expired") &&
            !String(request.headers.accept ?? "").includes("application/json")) {
          response.writeHead(status, {
            ...INTERACTION_SECURITY_HEADERS,
            "content-type": "text/html; charset=utf-8",
          });
          response.end(error.code === "different_account" ? renderDifferentAccountPage() : renderConsentResultPage());
        } else {
          json(response, status, clientResponse?.body ?? { error: "internal_error", request_id: requestId });
        }
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
    const admin = (adminTransactionContext(false)?.token ?? adminTransactionContext(false)?.continuation);
    if (admin) return admin.binding.owner_user_id === accountId
      ? { accountId, claims: async () => ({ sub: accountId }) } : undefined;
    const refreshGrantId = ctx?.oidc?.params?.grant_type === "refresh_token" &&
      typeof source?.grantId === "string" ? source.grantId : null;
    if (refreshGrantId !== null) {
      const result = await pool.query(
        `SELECT status.active
           FROM commonswarm_oauth.resolve_hosted_grant_status($1) AS status
          WHERE status.owner_user_id = $2::uuid
          LIMIT 1`,
        [refreshGrantId, accountId],
      );
      // Pending consent is omitted by the resolver: never tombstone a family
      // before consent can activate it. Admin transactions returned above.
      if (result.rowCount === 1 && result.rows[0]?.active === false) {
        await createPostgresAdapter(pool)("RefreshToken").revokeByGrantId(refreshGrantId);
      }
      return result.rowCount === 1 && result.rows[0]?.active === true ? {
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
  const runtimePool = createPool(config);
  const gotrue = createGoTrueClient({ pool: runtimePool, baseUrl: config.gotrueUrl, anonKey: config.supabaseAnonKey,
    providers: config.gotrueProviders ?? [config.gotrueProvider] });
  try { await gotrue.verifyProviders(); }
  catch (error) {
    await runtimePool.end();
    createLogger(writeLog).info({ event: "startup_refused", error_code: error.code,
      reason: "Configured sign-in providers must be enabled in GoTrue /auth/v1/settings" });
    throw error;
  }
  const issuerPool = config.adminIssuer ? new Pool({ ...config.database,
    user: config.adminIssuer.user, password: config.adminIssuer.password,
    application_name: "commonswarm-admin-issuer", connectionTimeoutMillis: 2000 }) : null;
  const pool = { query: (...args) => adminTransactionContext(false) ? adminQuery(...args) : runtimePool.query(...args),
    connect: () => adminTransactionContext(false)
      ? Promise.resolve({ query: adminQuery, release() {} }) : runtimePool.connect(),
    end: async () => { await issuerPool?.end(); await runtimePool.end(); } };
  const adminLifecycle = new AdminTokenLifecycle({ activeKid: config.activeSigningKid });
  let registrationStore;
  if (config.publicAuthorizationEnabled) {
    registrationStore = createPostgresRegistrationStore(pool);
    await registrationStore.cleanup();
  }
  const metadataFetch = createPostgresCimdFetch(pool, createPinnedMetadataFetch());
  const provider = await createMcpProvider({
    adapter: createPostgresAdapter(pool),
    activeSigningKid: config.activeSigningKid,
    ...(registrationStore ? { registrationStore } : {}),
    registrationEnabled: config.publicAuthorizationEnabled,
    registrationLimiter: createRegistrationLimiter(config.registrationLimits),
    cookieKeys: config.cookieKeys,
    jwks: config.jwks,
    authorizationCodeTtlSeconds: config.authorizationCodeTtlSeconds,
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
    nativeLoopbackEnabled: config.nativeLoopbackEnabled,
    metadataFetch,
    providerGrantResource: async grantId => {
      if (adminTransactionContext(false)) {
        return (await adminQuery(`SELECT resource FROM commonswarm_oauth.provider_grant_resources
          WHERE provider_grant_id=$1`, [grantId])).rows[0]?.resource;
      }
      return (await pool.query(`SELECT resource FROM commonswarm_oauth.resolve_hosted_grant_status($1)`,[grantId])).rows[0]?.resource;
    },
    providerGrantActive: async (grantId) => {
      const unit = (adminTransactionContext(false)?.token ?? adminTransactionContext(false)?.continuation);
      if (unit) return unit.binding.provider_grant_id === grantId;
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
  const store = new InteractionStore(pool);
  const finishFlow = config.publicAuthorizationEnabled && config.finishEnabled
    ? createFinishFlow({ provider, store, finishStore: new FinishStore(runtimePool, {
        issuer: config.issuer,
        verifySession: async (browser, client) => {
          const live = await readGoTrueSession(client, { sessionId: browser.gotrue_session_id, userId: browser.user_id });
          return live !== null && live.interactiveAuthAtSeconds === Math.floor(new Date(browser.authenticated_at).getTime() / 1000);
        },
      }) }) : undefined;
  const mcpHandler = config.publicAuthorizationEnabled
    ? createInteractionHandler({
        provider,
        store,
        finishFlow,
        gotrue,
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
  const interactionHandler = mcpHandler ? createResourceInteractionHandler({
    mcpHandler,
    adminHandler: createAdminInteractionHandler({
      provider, store: new InteractionStore(pool),
      service: createAdminConsentService({ store: new PostgresAdminConsentStore(pool), provider,
        completeInTransaction: (...args) => adminLifecycle.completeConsent(...args) }),
      gotrue,
      workspaceReader: async identity => {
        if (!adminTransactionContext(false)) return managementWorkspaceReader(identity);
        return withAdminRole("swarm_command", async () => (await adminQuery(`SELECT w.workspace_id AS id,w.name
          FROM swarm.workspaces w JOIN swarm.memberships m USING(workspace_id)
          WHERE m.user_id=$1 AND m.revoked_at IS NULL AND w.archived_at IS NULL ORDER BY w.name,w.workspace_id`,
          [identity.userId])).rows);
      }, allowedOrigins: config.allowedOrigins,
      callbackUrl: `${config.issuer}/oauth/callback/gotrue`,
      maxBodyBytes: config.maxBodyBytes, bodyReadTimeoutMs: config.requestTimeoutMs,
    }),
  }) : undefined;
  const handler = createHandler({ provider, pool, logger, interactionHandler, finishFlow,
    adminGateHandler: createAdminGateHandler({ issuerPool, adminIssuanceEnabled: config.adminIssuanceEnabled }), ...config });
  const ingress = createAdminHttpHandler({ handler, runtimePool, issuerPool,
    activeKid: config.activeSigningKid, adminIssuanceEnabled: config.adminIssuanceEnabled, logger });
  const server = createServer((request, response) =>
    request.url?.split("?", 1)[0] === "/admin/gate"
      ? handler(request, response) : ingress(request, response));
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs, 10_000);
  server.maxHeadersCount = 64;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", resolve);
  });
  if (registrationStore) {
    // Expiry is enforced in every lookup; deletion also runs while the service
    // is idle. Restart performs cleanup before accepting requests.
    const registrationCleanup = setInterval(() => {
      void registrationStore.cleanup().catch(() => logger.info({ event: "registration_cleanup_failed" }));
    }, 60 * 60 * 1000);
    registrationCleanup.unref();
    server.once("close", () => clearInterval(registrationCleanup));
  }
  return { server, provider, pool, registrationStore };
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
    process.stderr.write(`mcp-auth failed to start (${error?.code ?? "configuration_error"})${
      error instanceof DcrLimitConfigurationError ? `: ${error.message}` : ""}\n`);
    process.exitCode = 1;
  });
}

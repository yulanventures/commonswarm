import { createHash } from "node:crypto";
import { basename } from "node:path";
import { registrationErrorResponse } from "./registration.js";

const ALLOWED_FIELDS = new Set(["event", "method", "path", "request_id", "status", "duration_ms",
  "error_code", "error_name", "stack_frames", "registration_error_description", "grant_type", "grant_ref", "client_ref"]);

/** Non-secret correlation for token events: the grant type, the first 8 characters of the
 *  provider grant id, and a short hash of the public client id. Never a token or a secret. */
export function tokenEventFields(ctx) {
  const grantType = ctx?.oidc?.params?.grant_type;
  const grantId = ctx?.oidc?.entities?.RefreshToken?.grantId ?? ctx?.oidc?.entities?.AuthorizationCode?.grantId
    ?? ctx?.oidc?.entities?.Grant?.jti;
  const clientId = ctx?.oidc?.client?.clientId;
  return {
    grant_type: typeof grantType === "string" && /^[a-z_:.-]{1,64}$/u.test(grantType) ? grantType : null,
    grant_ref: typeof grantId === "string" ? grantId.slice(0, 8) : null,
    client_ref: typeof clientId === "string" ? createHash("sha256").update(clientId).digest("hex").slice(0, 8) : null,
  };
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/u.test(value)
    ? value : undefined;
}

export function logProviderError(logger, event, requestId, error, ctx) {
  const frames = [];
  // Ignore the message line and function names. Only conventional V8 source
  // locations are retained, with directory paths and columns removed.
  for (const line of typeof error?.stack === "string" ? error.stack.split("\n").slice(1) : []) {
    const location = /^\s+at (?:.* \()?((?:file:\/\/)?\/[^\s()?]+):(\d+):\d+\)?$/u.exec(line);
    if (!location) continue;
    const file = basename(location[1]);
    if (!/^[A-Za-z0-9_.-]+\.(?:js|mjs|cjs|ts)$/u.test(file)) continue;
    frames.push(`${file}:${location[2]}`);
    if (frames.length === 5) break;
  }
  logger.info({ event, request_id: requestId, ...(event === "grant.error" ? tokenEventFields(ctx) : {}), error_name: identifier(error?.name) ?? "Error",
    error_code: identifier(error?.code) ?? identifier(error?.error) ?? null, stack_frames: frames,
    ...(event === "registration_create.error" ? {
      registration_error_description: registrationErrorResponse(error).body.error_description,
    } : {}),
  });
}

export function subscribeProviderErrors(provider, logger) {
  // oidc-provider 9.12.2 emits these error events. Its interaction.started and
  // interaction.ended events are successes, not errors; custom interaction
  // failures are captured by the application's outer handler instead.
  for (const event of ["server_error", "authorization.error", "grant.error", "registration_create.error"]) {
    provider.on?.(event, (ctx, error) => {
      logProviderError(logger, event, ctx?.res?.getHeader("x-request-id"), error, ctx);
    });
  }
  // A hosted refresh repeat answered with its earlier rotation's response (no new tokens).
  provider.on?.("grant.replayed", (ctx) => {
    const clientId = ctx?.state?.replayedClientId;
    logger.info({ event: "grant.replayed", request_id: ctx?.res?.getHeader("x-request-id"), grant_type: "refresh_token",
      client_ref: typeof clientId === "string" ? createHash("sha256").update(clientId).digest("hex").slice(0, 8) : null });
  });
  // Successful token grants too, so a refused refresh can be paired with the rotation before it.
  provider.on?.("grant.success", (ctx) => {
    logger.info({ event: "grant.success", request_id: ctx?.res?.getHeader("x-request-id"), ...tokenEventFields(ctx) });
  });
}

export function createLogger(write = (line) => process.stdout.write(`${line}\n`)) {
  return {
    info(fields) {
      const safe = {};
      for (const [key, value] of Object.entries(fields ?? {})) {
        if (!ALLOWED_FIELDS.has(key)) continue;
        safe[key] = key === "path" ? String(value).split("?", 1)[0] : value;
      }
      write(JSON.stringify(safe));
    },
  };
}

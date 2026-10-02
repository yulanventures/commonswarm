import { basename } from "node:path";

const ALLOWED_FIELDS = new Set(["event", "method", "path", "request_id", "status", "duration_ms",
  "error_code", "error_name", "stack_frames"]);

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/u.test(value)
    ? value : undefined;
}

export function logProviderError(logger, event, requestId, error) {
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
  logger.info({ event, request_id: requestId, error_name: identifier(error?.name) ?? "Error",
    error_code: identifier(error?.code) ?? null, stack_frames: frames });
}

export function subscribeProviderErrors(provider, logger) {
  // oidc-provider 9.12.2 emits these error events. Its interaction.started and
  // interaction.ended events are successes, not errors; custom interaction
  // failures are captured by the application's outer handler instead.
  for (const event of ["server_error", "authorization.error", "grant.error"]) {
    provider.on?.(event, (ctx, error) => {
      logProviderError(logger, event, ctx?.res?.getHeader("x-request-id"), error);
    });
  }
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

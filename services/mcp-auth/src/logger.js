const ALLOWED_FIELDS = new Set(["event", "method", "path", "request_id", "status", "duration_ms", "error_code"]);

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

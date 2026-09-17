const delayMs = Number(process.env.CSWARM_TEST_PRELOAD_DELAY_MS ?? "0");
if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("invalid preload delay");
const waitUntil = performance.now() + delayMs;
while (performance.now() < waitUntil) {
  // Simulate bundle and host contention before the CLI handler starts.
}

globalThis.fetch = async () => await new Promise(() => undefined);
setInterval(() => undefined, 1_000);

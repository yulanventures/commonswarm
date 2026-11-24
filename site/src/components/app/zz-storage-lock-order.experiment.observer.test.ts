/**
 * TEMPORARY EXPERIMENT — NOT FOR MERGING.
 * Delete this file once it has answered the question in CI:
 * does Chromium order cross-tab localStorage replication against Web Lock
 * (`navigator.locks`) handoff, and does renderer process separation matter?
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright-core";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";

const ROUNDS = 200;
const LOCK_NAME = "L";
const STORAGE_KEY = "k";

interface StaleSample {
  round: number;
  expected: string;
  observed: string | null;
  writeAt: number;
  readAt: number;
  wallDeltaMs: number;
}

interface VariantResult {
  name: string;
  rounds: number;
  stale: number;
  round1Stale: number;
  samples: StaleSample[];
}

const EXPERIMENT_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Storage Lock Order Experiment</title></head>
<body>
<script>
window.__exp = {
  warm(key) {
    return localStorage.getItem(key);
  },
  seed(key, value) {
    localStorage.setItem(key, value);
  },
  async acquireHold(lockName) {
    let enteredResolve;
    const entered = new Promise((r) => { enteredResolve = r; });
    window.__bCommit = null;
    window.__bWriteInfo = null;
    window.__bLockDone = navigator.locks.request(lockName, async () => {
      const cmd = await new Promise((resolve) => {
        window.__bCommit = resolve;
        enteredResolve();
      });
      localStorage.setItem(cmd.key, cmd.value);
      window.__bWriteInfo = {
        writeAt: performance.now(),
        timeOrigin: performance.timeOrigin,
      };
    });
    await entered;
    return true;
  },
  async waitPendingAndRelease(lockName, key, value) {
    const deadline = performance.now() + 5000;
    let pendingConfirmed = false;
    while (performance.now() < deadline) {
      const snapshot = await navigator.locks.query();
      if ((snapshot.pending || []).some((entry) => entry.name === lockName)) {
        pendingConfirmed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    if (!pendingConfirmed) {
      if (window.__bCommit) window.__bCommit({ key, value });
      await window.__bLockDone;
      throw new Error("Timed out waiting for peer to queue on Web Lock " + lockName);
    }
    window.__bCommit({ key, value });
    await window.__bLockDone;
    return {
      pendingConfirmed: true,
      writeAt: window.__bWriteInfo.writeAt,
      timeOrigin: window.__bWriteInfo.timeOrigin,
    };
  },
  readUnderLock(lockName, key) {
    return navigator.locks.request(lockName, () => {
      const value = localStorage.getItem(key);
      const readAt = performance.now();
      return { value, readAt, timeOrigin: performance.timeOrigin };
    });
  },
};
</script>
</body>
</html>`;

async function runRounds(name: string, pageA: Page, pageB: Page): Promise<VariantResult> {
  let stale = 0;
  let round1Stale = 0;
  const samples: StaleSample[] = [];

  for (let i = 1; i <= ROUNDS; i += 1) {
    const expected = String(i);
    // 1. Page B acquires 'L' and holds it until A is confirmed pending.
    await pageB.evaluate(
      (lockName: string) =>
        (window as unknown as { __exp: { acquireHold(l: string): Promise<boolean> } }).__exp.acquireHold(lockName),
      LOCK_NAME,
    );

    // 2. Page A queues for 'L'; its FIRST statement inside 'L' reads localStorage.getItem('k') and performance.now().
    const aReadPromise = pageA.evaluate(
      (args: { lockName: string; storageKey: string }) =>
        (
          window as unknown as {
            __exp: {
              readUnderLock(l: string, k: string): Promise<{ value: string | null; readAt: number; timeOrigin: number }>;
            };
          }
        ).__exp.readUnderLock(args.lockName, args.storageKey),
      { lockName: LOCK_NAME, storageKey: STORAGE_KEY },
    );

    // 3. Page B confirms A is pending via navigator.locks.query(), writes String(i) inside 'L', and immediately releases 'L'.
    const bWrite = await pageB.evaluate(
      (args: { lockName: string; storageKey: string; value: string }) =>
        (
          window as unknown as {
            __exp: {
              waitPendingAndRelease(
                l: string,
                k: string,
                v: string,
              ): Promise<{ pendingConfirmed: boolean; writeAt: number; timeOrigin: number }>;
            };
          }
        ).__exp.waitPendingAndRelease(args.lockName, args.storageKey, args.value),
      { lockName: LOCK_NAME, storageKey: STORAGE_KEY, value: expected },
    );
    assert.equal(bWrite.pendingConfirmed, true, `${name} round ${i}: A must be pending before B releases`);

    // 4. Collect A's read taken as the first statement after receiving the lock.
    const aRead = await aReadPromise;
    if (aRead.value !== expected) {
      stale += 1;
      if (i === 1) round1Stale = 1;
      if (samples.length < 5) {
        const wallDeltaMs = Number(
          ((aRead.timeOrigin + aRead.readAt) - (bWrite.timeOrigin + bWrite.writeAt)).toFixed(3),
        );
        samples.push({
          round: i,
          expected,
          observed: aRead.value,
          writeAt: Number(bWrite.writeAt.toFixed(3)),
          readAt: Number(aRead.readAt.toFixed(3)),
          wallDeltaMs,
        });
      }
    }
  }

  return { name, rounds: ROUNDS, stale, round1Stale, samples };
}

function formatSamples(samples: readonly StaleSample[]): string {
  if (samples.length === 0) return "none";
  return samples
    .map(
      (s) =>
        `r${s.round}(got=${String(s.observed)},exp=${s.expected},write=${s.writeAt}ms,read=${s.readAt}ms,delta=${s.wallDeltaMs}ms)`,
    )
    .join(" ");
}

test("temporary experiment: Chromium localStorage visibility across Web Lock handoff", async (t) => {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(EXPERIMENT_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { chromium } = await import("playwright-core");
  let browser: Browser | null = null;
  try {
    browser = await launchPlaywrightChromium(chromium);
    const browserVersion = browser.version();

    // Variant 1: Two separate pages via context.newPage(), A warms localStorage.getItem('k') once first.
    let v1: VariantResult;
    {
      const context = await browser.newContext();
      try {
        const pageB = await context.newPage();
        await pageB.goto(`${origin}/exp?v=1&role=b`);
        await pageB.evaluate(
          (args: { key: string; value: string }) =>
            (window as unknown as { __exp: { seed(k: string, v: string): void } }).__exp.seed(args.key, args.value),
          { key: STORAGE_KEY, value: "0" },
        );

        const pageA = await context.newPage();
        await pageA.goto(`${origin}/exp?v=1&role=a`);
        await pageA.evaluate(
          (key: string) =>
            (window as unknown as { __exp: { warm(k: string): string | null } }).__exp.warm(key),
          STORAGE_KEY,
        );

        v1 = await runRounds("warmed-separate", pageA, pageB);
      } finally {
        await context.close();
      }
    }
    t.diagnostic(
      `[storage-lock-order] rounds=${v1.rounds} stale=${v1.stale} browser=${browserVersion} variant=${v1.name} samples=${formatSamples(v1.samples)}`,
    );

    // Variant 2: Two separate pages via context.newPage(), A does NOT warm localStorage before round 1.
    let v2: VariantResult;
    {
      const context = await browser.newContext();
      try {
        const pageB = await context.newPage();
        await pageB.goto(`${origin}/exp?v=2&role=b`);
        await pageB.evaluate(
          (args: { key: string; value: string }) =>
            (window as unknown as { __exp: { seed(k: string, v: string): void } }).__exp.seed(args.key, args.value),
          { key: STORAGE_KEY, value: "0" },
        );

        const pageA = await context.newPage();
        await pageA.goto(`${origin}/exp?v=2&role=a`);

        v2 = await runRounds("cold-separate", pageA, pageB);
      } finally {
        await context.close();
      }
    }
    t.diagnostic(
      `[storage-lock-order] rounds=${v2.rounds} stale=${v2.stale} browser=${browserVersion} variant=${v2.name} round1Stale=${v2.round1Stale} samples=${formatSamples(v2.samples)}`,
    );

    // Variant 3: Same process group via window.open from Page B, A warms localStorage.getItem('k') once first.
    let v3: VariantResult;
    {
      const context = await browser.newContext();
      try {
        const pageB = await context.newPage();
        await pageB.goto(`${origin}/exp?v=3&role=b`);
        await pageB.evaluate(
          (args: { key: string; value: string }) =>
            (window as unknown as { __exp: { seed(k: string, v: string): void } }).__exp.seed(args.key, args.value),
          { key: STORAGE_KEY, value: "0" },
        );

        const [pageA] = await Promise.all([
          context.waitForEvent("page"),
          pageB.evaluate((url: string) => {
            window.open(url, "storage-lock-order-a");
          }, `${origin}/exp?v=3&role=a`),
        ]);
        await pageA.waitForLoadState("load");
        await pageA.evaluate(
          (key: string) =>
            (window as unknown as { __exp: { warm(k: string): string | null } }).__exp.warm(key),
          STORAGE_KEY,
        );

        v3 = await runRounds("window-open-same-process", pageA, pageB);
      } finally {
        await context.close();
      }
    }
    t.diagnostic(
      `[storage-lock-order] rounds=${v3.rounds} stale=${v3.stale} browser=${browserVersion} variant=${v3.name} samples=${formatSamples(v3.samples)}`,
    );
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

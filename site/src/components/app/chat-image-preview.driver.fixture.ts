// Bounded real-time observer driver; reuses the repository's guarded launcher and existing CDP transport.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
import { connectKylonObserver } from "./kylon-host.fixture.js";
import type { ImageRequestFact } from "./chat-image-preview.fixture.js";

export function imagePreviewDriver(origin: string, started: number, requests: readonly ImageRequestFact[]) {
  let profile: string | undefined, socket: WebSocket | undefined;
  let settled: Promise<void> | undefined, launchFailure: unknown;
  let beforeDownload: unknown;
  let evaluate: ((expression: string) => Promise<any>) | undefined;
  return {
    observe: async () => {
    profile = await mkdtemp(join(tmpdir(), "commonswarm-image-observer-"));
    const launched = launchChrome(await findChrome(), [
      `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
    ], { timeout: 55_000, maxBuffer: 5 * 1024 * 1024, killSignal: "SIGKILL" });
    settled = launched.then(() => undefined, error => { launchFailure = error; });
    let port: string | undefined;
    const portDeadline = Date.now() + 10_000;
    while (!port && Date.now() < portDeadline) {
      if (launchFailure) throw launchFailure;
      try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; }
      catch { /* The owned bundled browser is starting. */ }
      if (!port) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(port, "the owned browser must expose DevTools");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json() as { type: string; webSocketDebuggerUrl: string }[];
    const target = targets.find(item => item.type === "page");
    assert.ok(target, "the owned browser must have its about:blank page");
    const connected = await connectKylonObserver(target.webSocketDebuggerUrl);
    socket = connected.socket;
    evaluate = async expression => {
      const result = await connected.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    };
    await connected.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    await connected.send("Page.bringToFront");
    await connected.send("Page.navigate", { url: origin });
    const waitFor = async (expression: string, timeout: number, label: string) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (launchFailure) throw launchFailure;
        if (await evaluate!(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`${label} timed out after ${timeout}ms real time`);
    };
    await waitFor("window.frames[0]?.imageObserver?.ready() === true", 10_000, "Image observation");
    beforeDownload = await evaluate("window.frames[0].imageObserver.diagnostics()");
    await evaluate("window.frames[0].imageObserver.finish().catch(error => window.frames[0].parent.postMessage({error:String(error)}, '*')); true");
    await waitFor("Boolean(window.imageObservation?.error || (window.imageObservation?.preview && window.imageObservation?.download))", 5000, "Download observation");
    const observation = await evaluate("window.imageObservation");
      return observation;
    },
    failure: async (error: unknown): Promise<Error> => {
    let browser: unknown;
    try {
      browser = await evaluate?.(`(() => {
        let fixture;try{fixture=window.frames[0]?.imageObserver?.diagnostics();}
        catch(error){fixture={unavailable:String(error)};}
        return {width:innerWidth,height:innerHeight,narrow:matchMedia('(max-width:832px)').matches,
          documentState:document.readyState,report:window.imageObservation,fixture};
      })()`);
    } catch (diagnosticError) { browser = { unavailable: String(diagnosticError) }; }
      return new Error(`${error instanceof Error ? error.stack : String(error)}\nImage observer diagnostics: ${JSON.stringify({wallMs:Date.now()-started,browser,beforeDownload,requests,launchFailure:String(launchFailure??'')})}`);
    },
    close: async () => {
      if (socket?.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ id: 999999, method: "Browser.close" })); }
        catch { /* The launcher's bounded process deadline still owns termination. */ }
      }
      await settled;
      socket?.close();
      if (profile) {
        const owned = await realpath(profile);
        assert.equal(dirname(owned), await realpath(tmpdir()), "cleanup canonical temporary root");
        assert.ok(basename(owned).startsWith("commonswarm-image-observer-"), "owned image observer cleanup only");
        await rm(owned, { recursive: true, force: true });
      }
    },
  };
}

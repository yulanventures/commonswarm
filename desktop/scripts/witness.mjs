import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { attachWindowHandlers, configurePermissions } from "../dist/handlers.js";
import {
  getAllowedDevOrigin,
  OVERRIDE_ENV_VAR,
  resolveAppUrl,
} from "../dist/policy.js";

const EXTERNAL_LINK_URL = "https://example.com/external-target";
const EXTERNAL_POPUP_URL = "https://example.com/external-popup";
const SUBFRAME_WINDOW_OPEN_URL = "https://example.com/from-frame";
const UNEXPECTED_REDIRECT_URL = "https://example.com/unexpected-redirect";
const SIGN_IN_HIJACK_URL = "https://api.commonswarm.com/auth/v1/authorize?provider=github";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind local test server"));
        return;
      }
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function waitForEvent(emitter, eventName, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(eventName, listener);
      reject(new Error(`timed out waiting for ${eventName}`));
    }, timeoutMs);

    const listener = (...args) => {
      if (!predicate || predicate(...args)) {
        clearTimeout(timer);
        emitter.off(eventName, listener);
        resolve(args);
      }
    };

    emitter.on(eventName, listener);
  });
}

async function waitForCondition(fn, description, timeoutMs = 4000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function realClickElement(win, elementId) {
  win.webContents.focus();
  await win.webContents.mainFrame.executeJavaScript(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );

  const coords = await win.webContents.mainFrame.executeJavaScript(`(() => {
    const el = document.getElementById(${JSON.stringify(elementId)});
    if (!el) throw new Error("missing element: " + ${JSON.stringify(elementId)});
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  })()`);

  win.webContents.sendInputEvent({ type: "mouseMove", x: coords.x, y: coords.y });
  win.webContents.sendInputEvent({
    type: "mouseDown",
    x: coords.x,
    y: coords.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(25);
  win.webContents.sendInputEvent({
    type: "mouseUp",
    x: coords.x,
    y: coords.y,
    button: "left",
    clickCount: 1,
  });
}

const results = [];
let failed = false;

async function runCheck(id, description, fn) {
  try {
    await fn();
    results.push({ id, ok: true, description });
    console.log(`PASS [${id}] ${description}`);
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    results.push({ id, ok: false, description, message });
    console.error(`FAIL [${id}] ${description}: ${message}`);
  }
}

async function main() {
  if (app.isPackaged) {
    throw new Error("witness must run unpackaged");
  }

  let appServer;
  let foreignServer;
  let win;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "commonswarm-witness-"));
  app.setPath("userData", userDataDir);

  const openedExternalUrls = [];
  const originalOpenExternal = shell.openExternal;
  const openExternalStub = async (url) => {
    openedExternalUrls.push(url);
  };

  try {
    shell.openExternal = openExternalStub;
  } catch {
    Object.defineProperty(shell, "openExternal", {
      configurable: true,
      writable: true,
      value: openExternalStub,
    });
  }
  assert.equal(
    shell.openExternal,
    openExternalStub,
    "failed to stub shell.openExternal; aborting before creating window",
  );

  const globalTimeout = setTimeout(() => {
    console.error("FAIL [timeout] witness exceeded 30s timeout");
    app.exit(1);
  }, 30_000);
  globalTimeout.unref();

  try {
    const foreign = await startServer((req, res) => {
      const reqPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (reqPath === "/subframe-start") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><title>Subframe Start</title><body>start</body>`);
        return;
      }
      if (reqPath === "/subframe-bounce") {
        res.writeHead(302, { location: `${foreign.origin}/subframe-final` });
        res.end();
        return;
      }
      if (reqPath === "/subframe-final") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><title>Subframe Final</title><body>foreign-final</body>`);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    foreignServer = foreign.server;

    const appSrv = await startServer((req, res) => {
      const reqPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (reqPath === "/app") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Witness App</title></head>
  <body style="margin:0;padding:0;">
    <a id="external-link" href="${EXTERNAL_LINK_URL}" style="display:block;width:240px;height:60px;margin:20px;">External link</a>
    <a id="external-popup-link" href="${EXTERNAL_POPUP_URL}" target="_blank" rel="noopener noreferrer" style="display:block;width:240px;height:60px;margin:20px;">External popup</a>
    <button id="inert-button" type="button" style="display:block;width:240px;height:60px;margin:20px;">Inert button</button>
  </body>
</html>`);
        return;
      }
      if (reqPath === "/redirect-foreign-https") {
        res.writeHead(302, { location: UNEXPECTED_REDIRECT_URL });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    appServer = appSrv.server;

    // Inject the local app origin strictly via the unpackaged-only env override.
    process.env[OVERRIDE_ENV_VAR] = `${appSrv.origin}/app`;
    const appUrl = resolveAppUrl({ isPackaged: app.isPackaged, env: process.env });
    const allowedDevOrigin = getAllowedDevOrigin(appUrl, app.isPackaged);
    assert.equal(appUrl, `${appSrv.origin}/app`, "appUrl should use unpackaged override");
    assert.equal(allowedDevOrigin, appSrv.origin, "allowedDevOrigin should match local app server");

    const policyOptions = { allowedDevOrigin };

    await app.whenReady();
    configurePermissions(policyOptions);

    win = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        allowRunningInsecureContent: false,
        devTools: false,
        backgroundThrottling: false,
      },
    });

    attachWindowHandlers(win, policyOptions);

    await win.loadURL(appUrl);
    await win.webContents.mainFrame.executeJavaScript(
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );

    // Run subframe-free checks (b, c, d) before attaching any iframe so window-open checks
    // execute in the real no-subframe state of the app.

    // (b) Main-frame redirect to a foreign https origin is cancelled and opens nothing
    await runCheck(
      "b",
      "main-frame redirect to foreign https origin is cancelled locally and opens nothing",
      async () => {
        openedExternalUrls.length = 0;

        const redirectPromise = waitForEvent(
          win.webContents,
          "will-redirect",
          (details) => details.isMainFrame && details.url === UNEXPECTED_REDIRECT_URL,
        );
        await win.webContents.mainFrame.executeJavaScript(
          `window.location.href = ${JSON.stringify(`${appSrv.origin}/redirect-foreign-https`)}`,
        );
        const [redirectDetails] = await redirectPromise;
        await sleep(150);

        assert.equal(redirectDetails.defaultPrevented, true, "unexpected main-frame redirect must be cancelled");
        assert.equal(openedExternalUrls.length, 0, `expected 0 external opens, got ${JSON.stringify(openedExternalUrls)}`);
        assert.equal(win.webContents.getURL(), appUrl, "main frame URL should remain on appUrl");
      },
    );

    // (c) Real click on an external link (and target=_blank noreferrer link) in the main frame
    // with NO subframe attached opens each exact URL once
    await runCheck(
      "c",
      "real click via sendInputEvent on external links in main frame (no subframes) opens exact URL once",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0, "check [c] must run with no subframes attached");
        openedExternalUrls.length = 0;

        await realClickElement(win, "external-link");
        await waitForCondition(() => openedExternalUrls.length > 0, "external URL open after real click");
        await sleep(150);

        assert.deepEqual(openedExternalUrls, [EXTERNAL_LINK_URL]);
        assert.equal(win.webContents.getURL(), appUrl, "main frame should stay on appUrl");

        // Also verify target="_blank" rel="noopener noreferrer" opens once via setWindowOpenHandler
        openedExternalUrls.length = 0;
        await realClickElement(win, "external-popup-link");
        await waitForCondition(() => openedExternalUrls.length > 0, "external popup URL open after real click");
        await sleep(150);

        assert.deepEqual(openedExternalUrls, [EXTERNAL_POPUP_URL]);
        assert.equal(win.webContents.getURL(), appUrl, "main frame should stay on appUrl");
      },
    );

    // (d) Same link triggered by script without a gesture opens nothing (also with no subframes attached)
    await runCheck(
      "d",
      "same external link triggered by script without a gesture is cancelled and opens nothing",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0, "check [d] should run with no subframes attached");
        openedExternalUrls.length = 0;

        const navPromise = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => details.isMainFrame && details.url === EXTERNAL_LINK_URL,
        );
        await win.webContents.mainFrame.executeJavaScript(
          `document.getElementById("external-link").click()`,
          false,
        );
        const [navDetails] = await navPromise;

        // Also verify script-driven window.open without gesture opens nothing even without subframes
        await win.webContents.mainFrame.executeJavaScript(
          `window.open(${JSON.stringify(EXTERNAL_POPUP_URL)}, "_blank", "noopener,noreferrer")`,
          false,
        );
        await sleep(150);

        assert.equal(navDetails.defaultPrevented, true, "script-triggered external navigation must be cancelled");
        assert.equal(openedExternalUrls.length, 0, `expected 0 external opens, got ${JSON.stringify(openedExternalUrls)}`);
        assert.equal(win.webContents.getURL(), appUrl, "main frame should stay on appUrl");
      },
    );

    // Now attach a foreign subframe and run checks (a, e, f, g) that exercise subframe isolation.

    // (a) Subframe navigating and redirecting to a foreign origin opens nothing and leaves main frame untouched
    await runCheck(
      "a",
      "subframe navigation and redirect to foreign origin opens nothing and keeps main frame on app",
      async () => {
        openedExternalUrls.length = 0;

        // Attach the iframe and navigate it to foreign /subframe-start
        const navPromise = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => !details.isMainFrame && details.url === `${foreign.origin}/subframe-start`,
        );
        await win.webContents.mainFrame.executeJavaScript(`(() => new Promise((resolve) => {
          const frame = document.createElement("iframe");
          frame.id = "subframe";
          frame.style.width = "240px";
          frame.style.height = "120px";
          frame.addEventListener("load", () => resolve(true), { once: true });
          frame.src = ${JSON.stringify(`${foreign.origin}/subframe-start`)};
          document.body.appendChild(frame);
        }))()`);
        const [navDetails] = await navPromise;
        assert.equal(navDetails.defaultPrevented, false, "subframe navigate should not be cancelled by top-level policy");

        // Now navigate inside the foreign subframe to /subframe-bounce which 302-redirects to /subframe-final
        const redirectPromise = waitForEvent(
          win.webContents,
          "will-redirect",
          (details) => !details.isMainFrame && details.url === `${foreign.origin}/subframe-final`,
        );
        const startFrame = await waitForCondition(
          () => win.webContents.mainFrame.frames.find((f) => !f.isDestroyed() && f.origin === foreign.origin),
          "foreign subframe to appear",
        );
        const loadedFinal = win.webContents.mainFrame.executeJavaScript(`(() => new Promise((resolve) => {
          const frame = document.getElementById("subframe");
          frame.addEventListener("load", () => resolve(true), { once: true });
        }))()`);
        await startFrame.executeJavaScript(
          `window.location.href = ${JSON.stringify(`${foreign.origin}/subframe-bounce`)}`,
        );
        const [redirectDetails] = await redirectPromise;
        await loadedFinal;
        await sleep(100);

        assert.equal(redirectDetails.defaultPrevented, false, "subframe redirect should not be cancelled by top-level policy");
        assert.equal(openedExternalUrls.length, 0, `expected 0 external opens, got ${JSON.stringify(openedExternalUrls)}`);
        assert.equal(win.webContents.getURL(), appUrl, "main frame URL should stay on appUrl");

        const finalFrame = win.webContents.mainFrame.frames.find(
          (f) => !f.isDestroyed() && f.url === `${foreign.origin}/subframe-final`,
        );
        assert.ok(finalFrame, "subframe should have completed redirect to foreign /subframe-final");
      },
    );

    // (e) Notification permission request from foreign-origin subframe is denied; app main frame is allowed
    await runCheck(
      "e",
      "notification permission denied for foreign-origin subframe and allowed for app main frame",
      async () => {
        const foreignFrame = win.webContents.mainFrame.frames.find(
          (f) => !f.isDestroyed() && f.origin === foreign.origin,
        );
        assert.ok(foreignFrame, "foreign subframe should be present");

        const foreignPermission = await foreignFrame.executeJavaScript(
          "Notification.requestPermission()",
          true,
        );
        assert.equal(foreignPermission, "denied", `expected foreign subframe permission denied, got ${foreignPermission}`);

        const appPermission = await win.webContents.mainFrame.executeJavaScript(
          "Notification.requestPermission()",
          true,
        );
        assert.equal(appPermission, "granted", `expected app main-frame permission granted, got ${appPermission}`);
      },
    );

    // (f) Main-frame navigation initiated by a foreign subframe is cancelled and opens nothing
    await runCheck(
      "f",
      "main-frame navigation initiated by foreign subframe is cancelled and opens nothing",
      async () => {
        openedExternalUrls.length = 0;
        const foreignFrame = win.webContents.mainFrame.frames.find(
          (f) => !f.isDestroyed() && f.origin === foreign.origin,
        );
        assert.ok(foreignFrame, "foreign subframe should be present");

        const navPromise = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => details.isMainFrame && details.url === SIGN_IN_HIJACK_URL,
        );
        await foreignFrame.executeJavaScript(
          `window.top.location.href = ${JSON.stringify(SIGN_IN_HIJACK_URL)}`,
          true,
        );
        const [navDetails] = await navPromise;
        await sleep(150);

        assert.equal(navDetails.defaultPrevented, true, "subframe-initiated main-frame navigation must be cancelled");
        assert.equal(openedExternalUrls.length, 0, `expected 0 external opens, got ${JSON.stringify(openedExternalUrls)}`);
        assert.equal(win.webContents.getURL(), appUrl, "main frame URL should stay on appUrl");
      },
    );

    // (g) With a foreign subframe attached, a real click on a non-navigating element in the main frame
    // followed immediately by the subframe calling window.open(..., "_blank", "noreferrer") opens nothing
    await runCheck(
      "g",
      "subframe window.open(..., noreferrer) immediately after real main-frame click opens nothing",
      async () => {
        openedExternalUrls.length = 0;
        const foreignFrame = win.webContents.mainFrame.frames.find(
          (f) => !f.isDestroyed() && f.origin === foreign.origin,
        );
        assert.ok(foreignFrame, "foreign subframe should be present");
        assert.ok(win.webContents.mainFrame.frames.length > 0, "main frame must have at least one subframe");

        await win.webContents.mainFrame.executeJavaScript(`(() => {
          window.__inertClickDone = new Promise((resolve) => {
            document.getElementById("inert-button").addEventListener("click", () => resolve(true), { once: true });
          });
        })()`);
        await realClickElement(win, "inert-button");
        await win.webContents.mainFrame.executeJavaScript("window.__inertClickDone");

        await foreignFrame.executeJavaScript(
          `window.open(${JSON.stringify(SUBFRAME_WINDOW_OPEN_URL)}, "_blank", "noreferrer")`,
          true,
        );
        await sleep(150);

        assert.equal(openedExternalUrls.length, 0, `expected 0 external opens, got ${JSON.stringify(openedExternalUrls)}`);
        assert.equal(win.webContents.getURL(), appUrl, "main frame URL should stay on appUrl");
      },
    );
  } finally {
    clearTimeout(globalTimeout);
    try {
      shell.openExternal = originalOpenExternal;
    } catch {
      // Ignore restore failure during shutdown.
    }
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
    await Promise.all([closeServer(appServer), closeServer(foreignServer)]);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp profile cleanup.
    }
    const exitCode = failed ? 1 : 0;
    process.exitCode = exitCode;
    app.quit();
    const forceExit = setTimeout(() => app.exit(exitCode), 1000);
    forceExit.unref();
  }
}

main().catch((error) => {
  console.error(`FAIL [fatal] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  app.exit(1);
});

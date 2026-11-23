import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import {
  attachWindowHandlers,
  configurePermissions,
  getPreloadAdditionalArguments,
  getPreloadPath,
} from "../dist/handlers.js";
import {
  CONTEXT_MENU_COPY_LINK_LABEL,
  CONTEXT_MENU_OPEN_LINK_LABEL,
  getAllowedDevOrigin,
  IPC_LINK_ACTIVATED,
  LINK_TICKET_WINDOW_MS,
  OVERRIDE_ENV_VAR,
  resolveAppUrl,
} from "../dist/policy.js";

const EXTERNAL_LINK_URL = "https://example.com/external-target";
const EXTERNAL_LINK_B_URL = "https://example.com/redirected-target-b";
const EXTERNAL_POPUP_URL = "https://example.com/external-popup";
const EXTERNAL_SCRIPT_NAV_URL = "https://example.com/scripted-after-button";
const EXTERNAL_SCRIPT_POPUP_URL = "https://example.com/scripted-popup-after-button";
const SUBFRAME_WINDOW_OPEN_URL = "https://example.com/from-frame";
const FOREIGN_SUBFRAME_EXT_URL = "https://example.com/foreign-subframe-link";
const SAME_ORIGIN_SUBFRAME_EXT_URL = "https://example.com/same-origin-subframe-ext";
const SAME_ORIGIN_SUBFRAME_TOP_URL = "https://example.com/same-origin-subframe-top";
const UNEXPECTED_REDIRECT_URL = "https://example.com/unexpected-redirect";
const SIGN_IN_FIRST_URL = "https://api.commonswarm.com/auth/v1/authorize?provider=github";
const SIGN_IN_SECOND_URL = "https://github.com/login/oauth/authorize?client_id=witness";

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
  let timer;
  let listener;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      emitter.off(eventName, listener);
      reject(new Error(`timed out waiting for ${eventName}`));
    }, timeoutMs);

    listener = (...args) => {
      if (!predicate || predicate(...args)) {
        clearTimeout(timer);
        emitter.off(eventName, listener);
        resolve(args);
      }
    };

    emitter.on(eventName, listener);
  });
  promise.cancel = () => {
    clearTimeout(timer);
    emitter.off(eventName, listener);
  };
  return promise;
}

async function waitForCondition(fn, description, timeoutMs = 4000, intervalMs = 15) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function waitForTwoFrames(win) {
  await win.webContents.mainFrame.executeJavaScript(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
}

async function getElementCenter(win, elementId) {
  win.webContents.focus();
  await waitForTwoFrames(win);

  const coords = await win.webContents.mainFrame.executeJavaScript(`(() => {
    const el = document.getElementById(${JSON.stringify(elementId)});
    if (!el) throw new Error("missing element: " + ${JSON.stringify(elementId)});
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  })()`);

  assert.ok(
    coords.x >= 0 && coords.y >= 0 && coords.x < 800 && coords.y < 600,
    `element #${elementId} out of viewport: ${JSON.stringify(coords)}`,
  );
  return coords;
}

async function getSubframeElementCenter(win, iframeId, childFrame, elementId) {
  win.webContents.focus();
  await waitForTwoFrames(win);

  const iframeRect = await win.webContents.mainFrame.executeJavaScript(`(() => {
    const iframe = document.getElementById(${JSON.stringify(iframeId)});
    if (!iframe) throw new Error("missing iframe: " + ${JSON.stringify(iframeId)});
    const rect = iframe.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  })()`);

  const childRect = await childFrame.executeJavaScript(`(() => {
    const el = document.getElementById(${JSON.stringify(elementId)});
    if (!el) throw new Error("missing subframe element: " + ${JSON.stringify(elementId)});
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  })()`);

  const coords = {
    x: Math.round(iframeRect.left + childRect.x),
    y: Math.round(iframeRect.top + childRect.y),
  };
  assert.ok(
    coords.x >= 0 && coords.y >= 0 && coords.x < 800 && coords.y < 600,
    `subframe element #${elementId} out of viewport: ${JSON.stringify(coords)}`,
  );
  return coords;
}

async function sendMouseClickAt(win, coords, button = "left") {
  win.webContents.sendInputEvent({ type: "mouseMove", x: coords.x, y: coords.y });
  await sleep(10);
  win.webContents.sendInputEvent({
    type: "mouseDown",
    x: coords.x,
    y: coords.y,
    button,
    clickCount: 1,
  });
  await sleep(25);
  win.webContents.sendInputEvent({
    type: "mouseUp",
    x: coords.x,
    y: coords.y,
    button,
    clickCount: 1,
  });
}

async function realClickElement(win, elementId) {
  const coords = await getElementCenter(win, elementId);
  await sendMouseClickAt(win, coords, "left");
}

async function realRightClickElement(win, elementId) {
  const coords = await getElementCenter(win, elementId);
  await sendMouseClickAt(win, coords, "right");
}

async function sendKeyPress(win, keyCode) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode });
  if (keyCode === "Return" || keyCode === "Enter") {
    // Blink activates <a href> on keydown, whereas <button> activates on keypress ('\r').
    // Send the matching char event so real Enter activates both links and buttons.
    await sleep(10);
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  }
  await sleep(20);
  win.webContents.sendInputEvent({ type: "keyUp", keyCode });
}

async function reloadAndWait(win) {
  const didNav = waitForEvent(win.webContents, "did-navigate");
  const didFinish = waitForEvent(win.webContents, "did-finish-load");
  await win.webContents.mainFrame.executeJavaScript("window.location.reload()");
  await Promise.all([didNav, didFinish]);
  await waitForTwoFrames(win);
}

async function attachIframe(win, iframeId, src) {
  await win.webContents.mainFrame.executeJavaScript(`(() => new Promise((resolve) => {
    const existing = document.getElementById(${JSON.stringify(iframeId)});
    if (existing) existing.remove();
    const frame = document.createElement("iframe");
    frame.id = ${JSON.stringify(iframeId)};
    frame.style.display = "block";
    frame.style.width = "320px";
    frame.style.height = "160px";
    frame.style.margin = "8px 20px";
    frame.style.border = "0";
    frame.addEventListener("load", () => resolve(true), { once: true });
    frame.src = ${JSON.stringify(src)};
    document.body.appendChild(frame);
  }))()`);
  await waitForTwoFrames(win);
}

async function removeIframe(win, iframeId) {
  await win.webContents.mainFrame.executeJavaScript(`(() => {
    const existing = document.getElementById(${JSON.stringify(iframeId)});
    if (existing) existing.remove();
  })()`);
  await waitForCondition(
    () => win.webContents.mainFrame.frames.length === 0,
    `iframe #${iframeId} to detach`,
  );
}

const results = [];
let failed = false;

// Prevent destroying the witness window during cleanup from triggering
// Electron's default app.quit() (which exits with status 0).
app.on("window-all-closed", () => {});

process.on("unhandledRejection", (reason) => {
  failed = true;
  console.error(
    `FAIL [unhandledRejection] ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`,
  );
  const passedCount = results.filter((r) => r.ok).length;
  console.log(`${passedCount} of ${results.length} passed`);
  app.exit(1);
});

process.on("uncaughtException", (error) => {
  failed = true;
  console.error(`FAIL [uncaughtException] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  const passedCount = results.filter((r) => r.ok).length;
  console.log(`${passedCount} of ${results.length} passed`);
  app.exit(1);
});

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
  const originalIpcMainOn = ipcMain.on;
  const originalIpcMainOff = ipcMain.off;
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
    failed = true;
    console.error("FAIL [timeout] witness exceeded 60s timeout");
    const passedCount = results.filter((r) => r.ok).length;
    console.log(`${passedCount} of ${results.length} passed`);
    app.exit(1);
  }, 60_000);
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
      if (reqPath === "/subframe-links") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Foreign Links</title></head>
  <body style="margin:0;padding:0;">
    <a id="foreign-ext-top" href="${FOREIGN_SUBFRAME_EXT_URL}" target="_top" style="display:block;width:240px;height:40px;margin:8px;">Foreign top link</a>
    <a id="foreign-ext-blank" href="${FOREIGN_SUBFRAME_EXT_URL}" target="_blank" rel="noopener noreferrer" style="display:block;width:240px;height:40px;margin:8px;">Foreign blank link</a>
  </body>
</html>`);
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
    <a id="external-link" href="${EXTERNAL_LINK_URL}" style="display:block;width:240px;height:36px;margin:8px 20px;">External link</a>
    <a id="external-popup-link" href="${EXTERNAL_POPUP_URL}" target="_blank" rel="noopener noreferrer" style="display:block;width:240px;height:36px;margin:8px 20px;">External popup</a>
    <a id="redirect-link" href="${EXTERNAL_LINK_URL}" style="display:block;width:240px;height:36px;margin:8px 20px;">Redirecting link</a>
    <a id="signin-link" href="${SIGN_IN_FIRST_URL}" style="display:block;width:240px;height:36px;margin:8px 20px;">Sign in</a>
    <button id="inert-button" type="button" style="display:block;width:240px;height:36px;margin:8px 20px;">Inert button</button>
    <a id="external-link-b" href="${EXTERNAL_LINK_B_URL}" style="display:block;width:240px;height:36px;margin:8px 20px;">External link B</a>
  </body>
</html>`);
        return;
      }
      if (reqPath === "/same-origin-subframe") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Same-Origin Subframe</title></head>
  <body style="margin:0;padding:0;">
    <a id="so-ext-blank" href="${SAME_ORIGIN_SUBFRAME_EXT_URL}" target="_blank" rel="noopener noreferrer" style="display:block;width:240px;height:40px;margin:8px;">Same-origin blank link</a>
    <a id="so-ext-top" href="${SAME_ORIGIN_SUBFRAME_TOP_URL}" target="_top" style="display:block;width:240px;height:40px;margin:8px;">Same-origin top link</a>
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
        preload: getPreloadPath(),
        additionalArguments: getPreloadAdditionalArguments(policyOptions),
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

    const presentedMenus = [];
    let nextMenuWaiter = null;
    const presentContextMenu = (template, targetWin) => {
      const record = { template, win: targetWin };
      presentedMenus.push(record);
      if (nextMenuWaiter) {
        const resolve = nextMenuWaiter;
        nextMenuWaiter = null;
        resolve(record);
      }
    };
    const waitForPresentedMenu = (timeoutMs = 4000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          nextMenuWaiter = null;
          reject(new Error("timed out waiting for context menu presentation"));
        }, timeoutMs);
        nextMenuWaiter = (record) => {
          clearTimeout(timer);
          resolve(record);
        };
      });

    const windowOpenWaiters = [];
    let productionWindowOpenHandlerWrapped = false;
    const originalSetWindowOpenHandler = win.webContents.setWindowOpenHandler.bind(win.webContents);
    const wrappedSetWindowOpenHandler = (handler) => {
      productionWindowOpenHandlerWrapped = true;
      return originalSetWindowOpenHandler((details) => {
        const result = handler(details);
        const record = {
          url: details.url,
          disposition: details.disposition,
          action: result?.action,
        };
        for (let i = windowOpenWaiters.length - 1; i >= 0; i -= 1) {
          const waiter = windowOpenWaiters[i];
          if (!waiter.predicate || waiter.predicate(record)) {
            windowOpenWaiters.splice(i, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(record);
          }
        }
        return result;
      });
    };
    try {
      win.webContents.setWindowOpenHandler = wrappedSetWindowOpenHandler;
    } catch {
      Object.defineProperty(win.webContents, "setWindowOpenHandler", {
        configurable: true,
        writable: true,
        value: wrappedSetWindowOpenHandler,
      });
    }
    assert.equal(
      win.webContents.setWindowOpenHandler,
      wrappedSetWindowOpenHandler,
      "failed to wrap setWindowOpenHandler in witness",
    );

    const waitForWindowOpenAttempt = (predicate, description = "window open attempt", timeoutMs = 4000) => {
      let waiter;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = windowOpenWaiters.indexOf(waiter);
          if (idx !== -1) windowOpenWaiters.splice(idx, 1);
          reject(new Error(`timed out waiting for ${description}`));
        }, timeoutMs);
        waiter = { predicate, resolve, timer };
        windowOpenWaiters.push(waiter);
      });
      promise.cancel = () => {
        const idx = windowOpenWaiters.indexOf(waiter);
        if (idx !== -1) windowOpenWaiters.splice(idx, 1);
        clearTimeout(waiter.timer);
      };
      return promise;
    };

    const activationDeliveredWaiters = [];
    let activeActivationHold = null;
    const wrappedIpcListeners = new Map();
    let productionLinkActivatedListenerWrapped = false;

    const notifyActivationDelivered = (record) => {
      for (let i = activationDeliveredWaiters.length - 1; i >= 0; i -= 1) {
        const waiter = activationDeliveredWaiters[i];
        if (!waiter.predicate || waiter.predicate(record)) {
          activationDeliveredWaiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(record);
        }
      }
    };

    const waitForActivationDelivered = (
      predicate,
      description = "link-activated IPC delivery",
      timeoutMs = 4000,
    ) => {
      let waiter;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = activationDeliveredWaiters.indexOf(waiter);
          if (idx !== -1) activationDeliveredWaiters.splice(idx, 1);
          reject(new Error(`timed out waiting for ${description}`));
        }, timeoutMs);
        waiter = { predicate, resolve, timer };
        activationDeliveredWaiters.push(waiter);
      });
      promise.cancel = () => {
        const idx = activationDeliveredWaiters.indexOf(waiter);
        if (idx !== -1) activationDeliveredWaiters.splice(idx, 1);
        clearTimeout(waiter.timer);
      };
      return promise;
    };

    // Witness-only IPC delivery wrapper on ipcMain (no production test hook).
    // Wraps registration of desktop:link-activated so a check can queue a real message
    // before it reaches the registered production handler, then release the untouched
    // original IpcMainEvent and payload directly into that registered handler.
    const armActivationHold = (predicate, description = "held link-activated IPC", timeoutMs = 4000) => {
      assert.equal(activeActivationHold, null, "overlapping IPC activation hold in witness");
      let settled = false;
      let resolveHeld;
      let rejectHeld;
      const heldPromise = new Promise((resolve, reject) => {
        resolveHeld = resolve;
        rejectHeld = reject;
      });
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (activeActivationHold === hold) activeActivationHold = null;
          rejectHeld(new Error(`timed out waiting for ${description}`));
        }
      }, timeoutMs);

      const hold = {
        predicate,
        capture(entry) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (activeActivationHold === hold) activeActivationHold = null;
          resolveHeld(entry);
        },
        waitForHeld() {
          return heldPromise;
        },
        disarm() {
          clearTimeout(timer);
          if (activeActivationHold === hold) activeActivationHold = null;
          settled = true;
        },
      };
      activeActivationHold = hold;
      return hold;
    };

    const boundIpcMainOn = originalIpcMainOn.bind(ipcMain);
    const boundIpcMainOff = originalIpcMainOff.bind(ipcMain);
    const wrappedIpcMainOn = (channel, listener) => {
      if (channel !== IPC_LINK_ACTIVATED) {
        return boundIpcMainOn(channel, listener);
      }
      productionLinkActivatedListenerWrapped = true;
      const wrapper = (event, ...args) => {
        const [url, activatedAt] = args;
        if (
          activeActivationHold &&
          (!activeActivationHold.predicate || activeActivationHold.predicate(event, args))
        ) {
          const entry = {
            channel,
            event,
            args,
            url,
            activatedAt,
            released: false,
            release: () => {
              if (entry.released) return;
              entry.released = true;
              listener(event, ...args);
              notifyActivationDelivered({ url, activatedAt, held: true });
            },
          };
          activeActivationHold.capture(entry);
          return;
        }
        listener(event, ...args);
        notifyActivationDelivered({ url, activatedAt, held: false });
      };
      wrappedIpcListeners.set(listener, wrapper);
      return boundIpcMainOn(channel, wrapper);
    };
    const wrappedIpcMainOff = (channel, listener) => {
      const wrapper = wrappedIpcListeners.get(listener);
      if (wrapper) {
        wrappedIpcListeners.delete(listener);
        return boundIpcMainOff(channel, wrapper);
      }
      return boundIpcMainOff(channel, listener);
    };
    try {
      ipcMain.on = wrappedIpcMainOn;
    } catch {
      Object.defineProperty(ipcMain, "on", {
        configurable: true,
        writable: true,
        value: wrappedIpcMainOn,
      });
    }
    try {
      ipcMain.off = wrappedIpcMainOff;
    } catch {
      Object.defineProperty(ipcMain, "off", {
        configurable: true,
        writable: true,
        value: wrappedIpcMainOff,
      });
    }
    assert.equal(ipcMain.on, wrappedIpcMainOn, "failed to wrap ipcMain.on in witness");
    assert.equal(ipcMain.off, wrappedIpcMainOff, "failed to wrap ipcMain.off in witness");

    attachWindowHandlers(win, policyOptions, { presentContextMenu });
    assert.equal(
      productionWindowOpenHandlerWrapped,
      true,
      "attachWindowHandlers must register setWindowOpenHandler",
    );
    assert.equal(
      productionLinkActivatedListenerWrapped,
      true,
      "attachWindowHandlers must register desktop:link-activated on ipcMain",
    );

    await win.loadURL(appUrl);
    await waitForTwoFrames(win);

    // -------------------------------------------------------------------------
    // Phase 1: Subframe-free checks (b, c, k, m, l, d, h, i, n, j, o, q, s, t, u)
    // -------------------------------------------------------------------------

    // (b) Main-frame redirect to a foreign https origin is cancelled and opens nothing
    await runCheck(
      "b",
      "main-frame redirect to foreign https origin is cancelled locally and opens nothing",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);
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

    // (c) Real click on external link repeated 20 times (ordering reliability check) + target=_blank link
    await runCheck(
      "c",
      "real click on external links in main frame (no subframes): 20/20 plain link + target=_blank opens exact URL once",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0, "check [c] must run with no subframes attached");
        let plainOpenedCount = 0;

        for (let i = 0; i < 20; i += 1) {
          openedExternalUrls.length = 0;
          await realClickElement(win, "external-link");
          try {
            await waitForCondition(
              () => openedExternalUrls.length > 0,
              `plain link open #${i + 1}`,
              1000,
              10,
            );
            await sleep(25);
            if (
              openedExternalUrls.length === 1 &&
              openedExternalUrls[0] === EXTERNAL_LINK_URL
            ) {
              plainOpenedCount += 1;
            }
          } catch {
            // Counted as missed in plainOpenedCount below.
          }
        }
        console.log(`METRIC [c] plain-link repeat: ${plainOpenedCount}/20 opened`);
        assert.equal(
          plainOpenedCount,
          20,
          `expected 20/20 plain-link opens (IPC-before-navigation ordering), got ${plainOpenedCount}/20`,
        );
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

    // (k) Keyboard: focus external link with real Tab key events and press Enter
    await runCheck(
      "k",
      "keyboard Tab focus to external link + real Enter opens exact URL once",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);
        openedExternalUrls.length = 0;
        win.webContents.focus();
        await win.webContents.mainFrame.executeJavaScript(`(() => {
          if (document.activeElement && typeof document.activeElement.blur === "function") {
            document.activeElement.blur();
          }
          document.body.focus();
        })()`);
        await waitForTwoFrames(win);

        let focusedId = null;
        for (let step = 0; step < 12; step += 1) {
          await sendKeyPress(win, "Tab");
          await sleep(25);
          focusedId = await win.webContents.mainFrame.executeJavaScript(
            "document.activeElement ? document.activeElement.id : null",
          );
          if (focusedId === "external-link") break;
        }
        assert.equal(focusedId, "external-link", `expected Tab to focus external-link, got ${focusedId}`);

        await sendKeyPress(win, "Return");
        await waitForCondition(() => openedExternalUrls.length > 0, "external URL open after Enter");
        await sleep(150);

        assert.deepEqual(openedExternalUrls, [EXTERNAL_LINK_URL]);
        assert.equal(win.webContents.getURL(), appUrl, "main frame should stay on appUrl");
      },
    );

    // (m) Native context menu: positive (open link + stale-doc reload refusal) and negative (foreign subframe)
    await runCheck(
      "m",
      "native menu opens exact link from app main frame, refuses after reload, and shows no open item in foreign subframe",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);
        openedExternalUrls.length = 0;
        presentedMenus.length = 0;

        // Positive: real right-click on external link in app main frame
        const menuPromise = waitForPresentedMenu();
        await realRightClickElement(win, "external-link");
        const menuRecord = await menuPromise;

        const labels = menuRecord.template.map((item) => item.label).filter(Boolean);
        assert.deepEqual(labels, [CONTEXT_MENU_OPEN_LINK_LABEL, CONTEXT_MENU_COPY_LINK_LABEL]);

        const openItem = menuRecord.template.find((item) => item.label === CONTEXT_MENU_OPEN_LINK_LABEL);
        assert.ok(openItem && typeof openItem.click === "function", "expected Open Link in Browser click handler");
        openItem.click();
        await sleep(100);

        assert.deepEqual(openedExternalUrls, [EXTERNAL_LINK_URL]);

        // Re-check document identity: after a same-URL reload, invoking the stale menu item opens nothing
        openedExternalUrls.length = 0;
        await reloadAndWait(win);
        assert.equal(win.webContents.getURL(), appUrl, "stale menu check must reload to the same appUrl");
        openItem.click();
        await sleep(100);
        assert.equal(
          openedExternalUrls.length,
          0,
          `stale context menu item must open nothing after reload, got ${JSON.stringify(openedExternalUrls)}`,
        );

        // Negative: right-click on a link inside a foreign subframe shows no open item
        await attachIframe(win, "temp-foreign-menu-frame", `${foreign.origin}/subframe-links`);
        try {
          const foreignFrame = await waitForCondition(
            () => win.webContents.mainFrame.frames.find((f) => !f.isDestroyed() && f.origin === foreign.origin),
            "foreign menu subframe",
          );
          presentedMenus.length = 0;
          openedExternalUrls.length = 0;

          const ctxEventPromise = waitForEvent(win.webContents, "context-menu");
          try {
            const coords = await getSubframeElementCenter(
              win,
              "temp-foreign-menu-frame",
              foreignFrame,
              "foreign-ext-top",
            );
            await sendMouseClickAt(win, coords, "right");
            const [_ctxEvent, ctxParams] = await ctxEventPromise;
            await sleep(100);

            assert.equal(ctxParams.linkURL, FOREIGN_SUBFRAME_EXT_URL);
            assert.equal(
              ctxParams.frame?.origin,
              foreign.origin,
              `context-menu event must originate from foreign subframe, got ${ctxParams.frame?.origin}`,
            );
            const hasOpenItem = presentedMenus.some((m) =>
              m.template.some((item) => item.label === CONTEXT_MENU_OPEN_LINK_LABEL),
            );
            assert.equal(hasOpenItem, false, "foreign subframe context menu must not show Open Link in Browser");
            assert.equal(openedExternalUrls.length, 0);
          } finally {
            ctxEventPromise.cancel();
          }
        } finally {
          await removeIframe(win, "temp-foreign-menu-frame");
        }
      },
    );

    // (l) Positive sign-in control: real production host names served locally via witness-only https protocol handler
    await runCheck(
      "l",
      "positive sign-in chain across real production sign-in hosts stays in window and opens nothing externally",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);
        openedExternalUrls.length = 0;
        const signedInReturnUrl = `${appSrv.origin}/app?signed_in=1`;

        const seenNavEvents = [];
        const seenRedirectEvents = [];
        const onWillFrameNav = (details) => {
          if (details.isMainFrame) {
            seenNavEvents.push({ url: details.url, defaultPrevented: details.defaultPrevented });
          }
        };
        const onWillRedirect = (details) => {
          if (details.isMainFrame) {
            seenRedirectEvents.push({ url: details.url, defaultPrevented: details.defaultPrevented });
          }
        };

        // Witness-only https protocol interception serving the exact production sign-in hosts locally.
        win.webContents.session.protocol.handle("https", (request) => {
          if (request.url === SIGN_IN_FIRST_URL) {
            return new Response(null, {
              status: 302,
              headers: { location: SIGN_IN_SECOND_URL },
            });
          }
          if (request.url === SIGN_IN_SECOND_URL) {
            return new Response(null, {
              status: 302,
              headers: { location: signedInReturnUrl },
            });
          }
          return new Response("blocked in witness", { status: 404 });
        });

        win.webContents.on("will-frame-navigate", onWillFrameNav);
        win.webContents.on("will-redirect", onWillRedirect);

        try {
          const finishedReturn = waitForEvent(
            win.webContents,
            "did-navigate",
            (_event, url) => url === signedInReturnUrl,
            6000,
          );
          await realClickElement(win, "signin-link");
          await finishedReturn;
          await waitForTwoFrames(win);
          await sleep(100);

          assert.equal(win.webContents.getURL(), signedInReturnUrl);
          assert.equal(openedExternalUrls.length, 0, `expected 0 external opens, got ${JSON.stringify(openedExternalUrls)}`);

          const firstNav = seenNavEvents.find((e) => e.url === SIGN_IN_FIRST_URL);
          assert.ok(firstNav, `production will-frame-navigate must see ${SIGN_IN_FIRST_URL}`);
          assert.equal(firstNav.defaultPrevented, false, "first sign-in navigation must not be cancelled");

          const secondRedirect = seenRedirectEvents.find((e) => e.url === SIGN_IN_SECOND_URL);
          assert.ok(secondRedirect, `production will-redirect must see ${SIGN_IN_SECOND_URL}`);
          assert.equal(secondRedirect.defaultPrevented, false, "second sign-in host redirect must not be cancelled");

          const returnRedirect = seenRedirectEvents.find((e) => e.url === signedInReturnUrl);
          assert.ok(returnRedirect, `production will-redirect must see return to ${signedInReturnUrl}`);
          assert.equal(returnRedirect.defaultPrevented, false, "return-to-app redirect must not be cancelled");
        } finally {
          win.webContents.off("will-frame-navigate", onWillFrameNav);
          win.webContents.off("will-redirect", onWillRedirect);
          win.webContents.session.protocol.unhandle("https");
          await win.loadURL(appUrl);
          await waitForTwoFrames(win);
        }
      },
    );

    // (d) Same link triggered by script without a gesture opens nothing (no subframes)
    await runCheck(
      "d",
      "same external link triggered by script without a gesture is cancelled and opens nothing",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);
        openedExternalUrls.length = 0;

        const navPromise = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => details.isMainFrame && details.url === EXTERNAL_LINK_URL,
        );
        let navDetails;
        try {
          const clickState = await win.webContents.mainFrame.executeJavaScript(`(() => {
            const link = document.getElementById("external-link");
            let fired = false;
            let isTrusted = null;
            link.addEventListener("click", (event) => {
              fired = true;
              isTrusted = event.isTrusted;
            }, { once: true });
            link.click();
            return { fired, isTrusted };
          })()`, false);
          assert.equal(clickState.fired, true, "[d]: script link.click() must fire click handler");
          assert.equal(clickState.isTrusted, false, "[d]: script link.click() must be untrusted");
          [navDetails] = await navPromise;
        } finally {
          navPromise.cancel();
        }

        const openPromise = waitForWindowOpenAttempt(
          (attempt) => attempt.url === EXTERNAL_POPUP_URL,
          `[d] setWindowOpenHandler for ${EXTERNAL_POPUP_URL}`,
        );
        let openAttempt;
        try {
          await win.webContents.mainFrame.executeJavaScript(
            `window.open(${JSON.stringify(EXTERNAL_POPUP_URL)}, "_blank", "noopener,noreferrer")`,
            false,
          );
          openAttempt = await openPromise;
        } finally {
          openPromise.cancel();
        }
        await sleep(150);

        assert.equal(navDetails.defaultPrevented, true, "script-triggered external navigation must be cancelled");
        assert.equal(openAttempt.action, "deny", "script-triggered window.open must be denied by setWindowOpenHandler");
        assert.equal(BrowserWindow.getAllWindows().length, 1, "no child BrowserWindow may be created");
        assert.equal(openedExternalUrls.length, 0, `expected 0 external opens, got ${JSON.stringify(openedExternalUrls)}`);
        assert.equal(win.webContents.getURL(), appUrl, "main frame should stay on appUrl");
      },
    );

    // (h) Real click on inert button, then immediately script sets location.href to external https URL
    await runCheck(
      "h",
      "real click on inert button followed immediately by location.href to external https URL is cancelled and opens nothing",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);
        openedExternalUrls.length = 0;

        await win.webContents.mainFrame.executeJavaScript(`(() => {
          const btn = document.getElementById("inert-button");
          window.__hState = { ran: false, isTrusted: null };
          window.__hListener = (event) => {
            window.__hState = { ran: true, isTrusted: event.isTrusted === true };
            window.location.href = ${JSON.stringify(EXTERNAL_SCRIPT_NAV_URL)};
          };
          btn.addEventListener("click", window.__hListener, { once: true });
        })()`);

        const navPromise = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => details.isMainFrame && details.url === EXTERNAL_SCRIPT_NAV_URL,
        );
        try {
          await realClickElement(win, "inert-button");
          const hState = await waitForCondition(
            () => win.webContents.mainFrame.executeJavaScript("window.__hState && window.__hState.ran ? window.__hState : null"),
            "[h] inert-button click handler to run",
          );
          assert.equal(hState.ran, true);
          assert.equal(hState.isTrusted, true, "[h]: click on inert-button must be trusted");

          const [navDetails] = await navPromise;
          await sleep(150);

          assert.equal(navDetails.defaultPrevented, true, "post-button external navigation must be cancelled");
          assert.equal(openedExternalUrls.length, 0, `expected 0 external opens, got ${JSON.stringify(openedExternalUrls)}`);
          assert.equal(win.webContents.getURL(), appUrl);
        } finally {
          navPromise.cancel();
          await win.webContents.mainFrame.executeJavaScript(`(() => {
            const btn = document.getElementById("inert-button");
            if (btn && window.__hListener) btn.removeEventListener("click", window.__hListener);
            window.__hListener = null;
          })()`).catch(() => {});
        }
      },
    );

    // (i) Real click on inert button, then immediately script calls window.open on external https URL
    await runCheck(
      "i",
      "real click on inert button followed immediately by window.open to external https URL opens nothing",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);
        openedExternalUrls.length = 0;

        await win.webContents.mainFrame.executeJavaScript(`(() => {
          const btn = document.getElementById("inert-button");
          window.__iState = { ran: false, isTrusted: null };
          window.__iListener = (event) => {
            window.__iState = { ran: true, isTrusted: event.isTrusted === true };
            window.open(${JSON.stringify(EXTERNAL_SCRIPT_POPUP_URL)}, "_blank", "noopener,noreferrer");
          };
          btn.addEventListener("click", window.__iListener, { once: true });
        })()`);

        const openPromise = waitForWindowOpenAttempt(
          (attempt) => attempt.url === EXTERNAL_SCRIPT_POPUP_URL,
          `[i] setWindowOpenHandler for ${EXTERNAL_SCRIPT_POPUP_URL}`,
        );
        try {
          await realClickElement(win, "inert-button");
          const iState = await waitForCondition(
            () => win.webContents.mainFrame.executeJavaScript("window.__iState && window.__iState.ran ? window.__iState : null"),
            "[i] inert-button click handler to run",
          );
          assert.equal(iState.ran, true);
          assert.equal(iState.isTrusted, true, "[i]: click on inert-button must be trusted");

          const openAttempt = await openPromise;
          await sleep(150);

          assert.equal(openAttempt.action, "deny", "[i]: window.open must be denied by setWindowOpenHandler");
          assert.equal(BrowserWindow.getAllWindows().length, 1, "no child BrowserWindow may be created");
          assert.equal(openedExternalUrls.length, 0, `expected 0 external opens, got ${JSON.stringify(openedExternalUrls)}`);
          assert.equal(win.webContents.getURL(), appUrl);
        } finally {
          openPromise.cancel();
          await win.webContents.mainFrame.executeJavaScript(`(() => {
            const btn = document.getElementById("inert-button");
            if (btn && window.__iListener) btn.removeEventListener("click", window.__iListener);
            window.__iListener = null;
          })()`).catch(() => {});
        }
      },
    );

    // (n) Reviewer's hover/focus split controls:
    //     1) pointer rests on link A, focus on inert button -> Enter on button navigates to A: opens nothing
    //     2) focus on link A, real click on inert button navigates to A: opens nothing
    await runCheck(
      "n",
      "hover/focus mismatch controls (hover link A + Enter button; focus link A + click button) open nothing",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);

        // Part 1: hover on external-link A, focus on inert-button, press Enter
        openedExternalUrls.length = 0;

        const linkCoords = await getElementCenter(win, "external-link");
        // Move pointer off all links first so moving onto link A is a fresh entry.
        win.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
        await sleep(30);

        await win.webContents.mainFrame.executeJavaScript(`(() => {
          const link = document.getElementById("external-link");
          const btn = document.getElementById("inert-button");
          window.__n1State = {
            ran: false,
            isTrusted: null,
            targetId: null,
            linkHoveredAtClick: false,
            activeIdAtClick: null,
          };
          btn.focus();
          window.__n1Listener = (event) => {
            window.__n1State = {
              ran: true,
              isTrusted: event.isTrusted === true,
              targetId: event.target instanceof Element ? event.target.id : null,
              linkHoveredAtClick: Boolean(link && link.matches(":hover")),
              activeIdAtClick: document.activeElement ? document.activeElement.id : null,
            };
            window.location.href = ${JSON.stringify(EXTERNAL_LINK_URL)};
          };
          btn.addEventListener("click", window.__n1Listener, { once: true });
        })()`);

        const targetUrlPromise = waitForEvent(
          win.webContents,
          "update-target-url",
          (_event, url) => url === EXTERNAL_LINK_URL,
        );
        const navPromise1 = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => details.isMainFrame && details.url === EXTERNAL_LINK_URL,
        );
        try {
          win.webContents.sendInputEvent({ type: "mouseMove", x: linkCoords.x, y: linkCoords.y });
          const [_targetEvent, hoveredTargetUrl] = await targetUrlPromise;
          await waitForTwoFrames(win);

          const preN1 = await win.webContents.mainFrame.executeJavaScript(`(() => {
            const link = document.getElementById("external-link");
            const hit = document.elementFromPoint(${linkCoords.x}, ${linkCoords.y});
            return {
              activeId: document.activeElement ? document.activeElement.id : null,
              linkHovered: Boolean(link && link.matches(":hover")),
              hitId: hit ? hit.id : null,
            };
          })()`);
          assert.equal(hoveredTargetUrl, EXTERNAL_LINK_URL, "[n] part 1: update-target-url must report link A");
          assert.equal(
            preN1.activeId,
            "inert-button",
            `[n] part 1: expected focus on inert-button before Enter, got ${preN1.activeId}`,
          );
          assert.equal(preN1.linkHovered, true, "[n] part 1: external-link must match :hover before Enter");
          assert.equal(
            preN1.hitId,
            "external-link",
            `[n] part 1: expected pointer coordinates to hit external-link, got ${preN1.hitId}`,
          );

          await sendKeyPress(win, "Return");
          const n1State = await waitForCondition(
            () => win.webContents.mainFrame.executeJavaScript("window.__n1State && window.__n1State.ran ? window.__n1State : null"),
            "[n] part 1 inert-button click handler to run on Enter",
          );
          assert.equal(n1State.ran, true, "[n] part 1: inert-button handler must run");
          assert.equal(n1State.isTrusted, true, "[n] part 1: Enter on inert-button must produce a trusted click");
          assert.equal(n1State.targetId, "inert-button", `[n] part 1: expected target inert-button, got ${n1State.targetId}`);
          assert.equal(
            n1State.linkHoveredAtClick,
            true,
            "[n] part 1: pointer must still hover external-link when button handler runs",
          );
          assert.equal(
            n1State.activeIdAtClick,
            "inert-button",
            `[n] part 1: inert-button must remain focused when handler runs, got ${n1State.activeIdAtClick}`,
          );

          const [navDetails1] = await navPromise1;
          await sleep(150);

          assert.equal(navDetails1.defaultPrevented, true, "hover-link + Enter-button nav must be cancelled");
          assert.equal(openedExternalUrls.length, 0);
        } finally {
          targetUrlPromise.cancel();
          navPromise1.cancel();
          await win.webContents.mainFrame.executeJavaScript(`(() => {
            const btn = document.getElementById("inert-button");
            if (btn && window.__n1Listener) btn.removeEventListener("click", window.__n1Listener);
            window.__n1Listener = null;
          })()`).catch(() => {});
        }

        // Part 2 (mirror): focus on external-link A, real click on inert-button whose handler navigates to A
        openedExternalUrls.length = 0;

        const btnCoords = await getElementCenter(win, "inert-button");
        const preN2 = await win.webContents.mainFrame.executeJavaScript(`(() => {
          const link = document.getElementById("external-link");
          const btn = document.getElementById("inert-button");
          window.__n2State = { ran: false, isTrusted: null, targetId: null };
          link.focus();
          window.__n2Listener = (event) => {
            window.__n2State = {
              ran: true,
              isTrusted: event.isTrusted === true,
              targetId: event.target instanceof Element ? event.target.id : null,
            };
            window.location.href = ${JSON.stringify(EXTERNAL_LINK_URL)};
          };
          btn.addEventListener("click", window.__n2Listener, { once: true });
          return {
            activeId: document.activeElement ? document.activeElement.id : null,
          };
        })()`);
        assert.equal(
          preN2.activeId,
          "external-link",
          `[n] part 2: expected document.activeElement to be external-link before clicking button, got ${preN2.activeId}`,
        );

        const navPromise2 = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => details.isMainFrame && details.url === EXTERNAL_LINK_URL,
        );
        try {
          await sendMouseClickAt(win, btnCoords, "left");
          const n2State = await waitForCondition(
            () => win.webContents.mainFrame.executeJavaScript("window.__n2State && window.__n2State.ran ? window.__n2State : null"),
            "[n] part 2 inert-button click handler to run on click",
          );
          assert.equal(n2State.ran, true, "[n] part 2: inert-button handler must run");
          assert.equal(n2State.isTrusted, true, "[n] part 2: real click on inert-button must be trusted");
          assert.equal(n2State.targetId, "inert-button", `[n] part 2: expected target inert-button, got ${n2State.targetId}`);

          const [navDetails2] = await navPromise2;
          await sleep(150);

          assert.equal(navDetails2.defaultPrevented, true, "focus-link + click-button nav must be cancelled");
          assert.equal(openedExternalUrls.length, 0);
          assert.equal(win.webContents.getURL(), appUrl);
        } finally {
          navPromise2.cancel();
          await win.webContents.mainFrame.executeJavaScript(`(() => {
            const btn = document.getElementById("inert-button");
            if (btn && window.__n2Listener) btn.removeEventListener("click", window.__n2Listener);
            window.__n2Listener = null;
          })()`).catch(() => {});
        }
      },
    );

    // (j) Real click on external link A whose click handler redirects to B: B never opens and A does not open
    await runCheck(
      "j",
      "real click on external link A whose click handler redirects to B opens neither B nor A",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);
        openedExternalUrls.length = 0;

        await win.webContents.mainFrame.executeJavaScript(`(() => {
          const link = document.getElementById("redirect-link");
          window.__jState = { ran: false, isTrusted: null };
          window.__jListener = (event) => {
            event.preventDefault();
            window.__jState = { ran: true, isTrusted: event.isTrusted === true };
            window.location.href = ${JSON.stringify(EXTERNAL_LINK_B_URL)};
          };
          link.addEventListener("click", window.__jListener, { once: true });
        })()`);

        const navPromiseB = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => details.isMainFrame && details.url === EXTERNAL_LINK_B_URL,
        );
        let clickAt;
        try {
          await realClickElement(win, "redirect-link");
          clickAt = Date.now();
          const jState = await waitForCondition(
            () => win.webContents.mainFrame.executeJavaScript("window.__jState && window.__jState.ran ? window.__jState : null"),
            "[j] redirect-link click handler to run",
          );
          assert.equal(jState.ran, true);
          assert.equal(jState.isTrusted, true, "[j]: click on redirect-link must be trusted");

          const [navDetailsB] = await navPromiseB;
          await sleep(100);

          assert.equal(navDetailsB.defaultPrevented, true, "redirect to B must be cancelled");
          assert.equal(
            openedExternalUrls.length,
            0,
            `expected B not to open, got ${JSON.stringify(openedExternalUrls)}`,
          );
        } finally {
          navPromiseB.cancel();
          await win.webContents.mainFrame.executeJavaScript(`(() => {
            const link = document.getElementById("redirect-link");
            if (link && window.__jListener) link.removeEventListener("click", window.__jListener);
            window.__jListener = null;
          })()`).catch(() => {});
        }

        // Verify the mismatched navigation to B burned the ticket for A: a follow-up navigation to A
        // inside the ticket window is also cancelled and opens nothing.
        const elapsedBeforeA = Date.now() - clickAt;
        assert.ok(
          elapsedBeforeA < LINK_TICKET_WINDOW_MS,
          `[j] follow-up navigation to A (${elapsedBeforeA}ms) must stay inside ${LINK_TICKET_WINDOW_MS}ms ticket window`,
        );

        const navPromiseA = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => details.isMainFrame && details.url === EXTERNAL_LINK_URL,
        );
        try {
          await win.webContents.mainFrame.executeJavaScript(
            `window.location.href = ${JSON.stringify(EXTERNAL_LINK_URL)}`,
          );
          const [navDetailsA] = await navPromiseA;
          await sleep(150);

          assert.equal(navDetailsA.defaultPrevented, true, "follow-up navigation to A after B burned ticket must be cancelled");
          assert.equal(
            openedExternalUrls.length,
            0,
            `expected neither B nor A to open, got ${JSON.stringify(openedExternalUrls)}`,
          );
          assert.equal(win.webContents.getURL(), appUrl);
        } finally {
          navPromiseA.cancel();
        }
      },
    );

    // (o) Forged activation: synthetic dispatchEvent and a.click(), then navigate to A: opens nothing
    await runCheck(
      "o",
      "forged activation (dispatchEvent MouseEvent and a.click()) followed by navigation to A opens nothing",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);
        openedExternalUrls.length = 0;

        // Synthetic MouseEvent dispatchEvent + location.href = A
        const navPromise1 = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => details.isMainFrame && details.url === EXTERNAL_LINK_URL,
        );
        try {
          const forge1 = await win.webContents.mainFrame.executeJavaScript(`(() => {
            const link = document.getElementById("external-link");
            let fired = false;
            let isTrusted = null;
            link.addEventListener("click", (e) => {
              fired = true;
              isTrusted = e.isTrusted;
              e.preventDefault();
            }, { once: true });
            link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
            window.location.href = ${JSON.stringify(EXTERNAL_LINK_URL)};
            return { fired, isTrusted };
          })()`);
          assert.equal(forge1.fired, true, "[o] part 1: synthetic dispatchEvent click must fire on external-link");
          assert.equal(forge1.isTrusted, false, "[o] part 1: synthetic dispatchEvent click must be untrusted");

          const [navDetails1] = await navPromise1;
          await sleep(150);
          assert.equal(navDetails1.defaultPrevented, true);
          assert.equal(openedExternalUrls.length, 0);
        } finally {
          navPromise1.cancel();
        }

        // Synthetic a.click() + location.href = A
        const navPromise2 = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => details.isMainFrame && details.url === EXTERNAL_LINK_URL,
        );
        try {
          const forge2 = await win.webContents.mainFrame.executeJavaScript(`(() => {
            const link = document.getElementById("external-link");
            let fired = false;
            let isTrusted = null;
            link.addEventListener("click", (e) => {
              fired = true;
              isTrusted = e.isTrusted;
              e.preventDefault();
            }, { once: true });
            link.click();
            window.location.href = ${JSON.stringify(EXTERNAL_LINK_URL)};
            return { fired, isTrusted };
          })()`);
          assert.equal(forge2.fired, true, "[o] part 2: synthetic a.click() must fire on external-link");
          assert.equal(forge2.isTrusted, false, "[o] part 2: synthetic a.click() must be untrusted");

          const [navDetails2] = await navPromise2;
          await sleep(150);
          assert.equal(navDetails2.defaultPrevented, true);
          assert.equal(openedExternalUrls.length, 0);
          assert.equal(win.webContents.getURL(), appUrl);
        } finally {
          navPromise2.cancel();
        }
      },
    );

    // (q) Same-URL reload retires an unspent ticket (both immediate and delayed inside the 1000ms window)
    await runCheck(
      "q",
      "same-URL reload retires unspent ticket (immediate and delayed within ticket window)",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);

        for (const delayMs of [0, 150]) {
          openedExternalUrls.length = 0;

          await win.webContents.mainFrame.executeJavaScript(`(() => {
            const link = document.getElementById("external-link");
            window.__ticketIssuedClick = new Promise((resolve) => {
              link.addEventListener("click", (event) => {
                event.preventDefault();
                resolve({ ran: true, isTrusted: event.isTrusted === true });
              }, { once: true });
            });
          })()`);

          await realClickElement(win, "external-link");
          const ticketClick = await win.webContents.mainFrame.executeJavaScript("window.__ticketIssuedClick");
          assert.equal(ticketClick.ran, true, `[q] (delay=${delayMs}ms): click on external-link must run`);
          assert.equal(ticketClick.isTrusted, true, `[q] (delay=${delayMs}ms): click on external-link must be trusted`);
          const clickAt = Date.now();
          await sleep(15);

          await reloadAndWait(win);
          if (delayMs > 0) {
            await sleep(delayMs);
          }

          const elapsed = Date.now() - clickAt;
          assert.ok(
            elapsed < LINK_TICKET_WINDOW_MS,
            `reload + delay (${elapsed}ms) must stay inside ${LINK_TICKET_WINDOW_MS}ms ticket window`,
          );

          const navPromise = waitForEvent(
            win.webContents,
            "will-frame-navigate",
            (details) => details.isMainFrame && details.url === EXTERNAL_LINK_URL,
          );
          try {
            await win.webContents.mainFrame.executeJavaScript(
              `window.location.href = ${JSON.stringify(EXTERNAL_LINK_URL)}`,
            );
            const [navDetails] = await navPromise;
            await sleep(150);

            assert.equal(
              navDetails.defaultPrevented,
              true,
              `navigation to A after same-URL reload (delay=${delayMs}ms) must be cancelled`,
            );
            assert.equal(
              openedExternalUrls.length,
              0,
              `expected 0 external opens after reload (delay=${delayMs}ms), got ${JSON.stringify(openedExternalUrls)}`,
            );
            assert.equal(win.webContents.getURL(), appUrl);
          } finally {
            navPromise.cancel();
          }
        }
      },
    );

    // (s) Held activation processed after retirement (same-URL reload)
    await runCheck(
      "s",
      "held activation IPC released into registered handler after same-URL reload opens nothing",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);
        openedExternalUrls.length = 0;

        await win.webContents.mainFrame.executeJavaScript(`(() => {
          const link = document.getElementById("external-link");
          window.__sClick = { ran: false, isTrusted: null };
          window.__sListener = (event) => {
            event.preventDefault();
            window.__sClick = { ran: true, isTrusted: event.isTrusted === true };
          };
          link.addEventListener("click", window.__sListener, { once: true });
        })()`);

        const hold = armActivationHold(
          (_event, args) => args[0] === EXTERNAL_LINK_URL,
          "[s] held desktop:link-activated for link A",
        );
        let navPromise = null;
        try {
          await realClickElement(win, "external-link");
          const sClick = await waitForCondition(
            () => win.webContents.mainFrame.executeJavaScript("window.__sClick && window.__sClick.ran ? window.__sClick : null"),
            "[s] external-link click handler to run",
          );
          assert.equal(sClick.ran, true, "[s]: click on external-link must run");
          assert.equal(sClick.isTrusted, true, "[s]: click on external-link must be trusted");

          const heldEntry = await hold.waitForHeld();
          assert.equal(heldEntry.url, EXTERNAL_LINK_URL, "[s]: held message must carry link A URL");
          assert.equal(
            Number.isSafeInteger(heldEntry.activatedAt),
            true,
            `[s]: held message must carry integer click time, got ${String(heldEntry.activatedAt)}`,
          );

          await reloadAndWait(win);
          assert.equal(win.webContents.getURL(), appUrl, "[s]: reload must stay on same appUrl");

          const elapsedBeforeRelease = Date.now() - heldEntry.activatedAt;
          assert.ok(
            elapsedBeforeRelease < LINK_TICKET_WINDOW_MS,
            `[s]: reload (${elapsedBeforeRelease}ms) must finish inside ${LINK_TICKET_WINDOW_MS}ms lifetime so refusal is by retirement`,
          );

          // Deliver the held message with its untouched IpcMainEvent into the registered production handler.
          heldEntry.release();

          navPromise = waitForEvent(
            win.webContents,
            "will-frame-navigate",
            (details) => details.isMainFrame && details.url === EXTERNAL_LINK_URL,
          );
          await win.webContents.mainFrame.executeJavaScript(
            `window.location.href = ${JSON.stringify(EXTERNAL_LINK_URL)}`,
          );
          const [navDetails] = await navPromise;
          const elapsedAtNav = Date.now() - heldEntry.activatedAt;
          assert.ok(
            elapsedAtNav < LINK_TICKET_WINDOW_MS,
            `[s]: post-release navigation (${elapsedAtNav}ms) must stay inside ${LINK_TICKET_WINDOW_MS}ms lifetime`,
          );
          await sleep(150);

          assert.equal(navDetails.defaultPrevented, true, "[s]: navigation to A after retired held activation must be cancelled");
          assert.equal(
            openedExternalUrls.length,
            0,
            `[s]: expected 0 external opens after releasing held pre-reload activation, got ${JSON.stringify(openedExternalUrls)}`,
          );
          assert.equal(win.webContents.getURL(), appUrl);
        } finally {
          hold.disarm();
          if (navPromise) navPromise.cancel();
          await win.webContents.mainFrame.executeJavaScript(`(() => {
            const link = document.getElementById("external-link");
            if (link && window.__sListener) link.removeEventListener("click", window.__sListener);
            window.__sListener = null;
          })()`).catch(() => {});
        }
      },
    );

    // (t) Delayed activation after a refused attempt with an unrelated live ticket
    await runCheck(
      "t",
      "delayed activation for B after refused attempt to B while A has live ticket opens nothing, and a fresh click still opens once",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);
        openedExternalUrls.length = 0;

        await win.webContents.mainFrame.executeJavaScript(`(() => {
          const linkA = document.getElementById("external-link");
          const linkB = document.getElementById("external-link-b");
          window.__tClickA = { ran: false, isTrusted: null };
          window.__tClickB = { ran: false, isTrusted: null };
          window.__tListenerA = (event) => {
            event.preventDefault();
            window.__tClickA = { ran: true, isTrusted: event.isTrusted === true };
          };
          window.__tListenerB = (event) => {
            event.preventDefault();
            window.__tClickB = { ran: true, isTrusted: event.isTrusted === true };
          };
          linkA.addEventListener("click", window.__tListenerA, { once: true });
          linkB.addEventListener("click", window.__tListenerB, { once: true });
        })()`);

        const deliveredAPromise = waitForActivationDelivered(
          (record) => record.url === EXTERNAL_LINK_URL && record.held === false,
          "[t] link A activation IPC delivery",
        );
        let holdB = null;
        let navPromiseB1 = null;
        let navPromiseB2 = null;
        try {
          // 1. Real click on link A -> issues live ticket for A
          await realClickElement(win, "external-link");
          const clickA = await waitForCondition(
            () => win.webContents.mainFrame.executeJavaScript("window.__tClickA && window.__tClickA.ran ? window.__tClickA : null"),
            "[t] link A click handler to run",
          );
          assert.equal(clickA.ran, true, "[t]: click on link A must run");
          assert.equal(clickA.isTrusted, true, "[t]: click on link A must be trusted");
          const deliveredA = await deliveredAPromise;
          assert.equal(Number.isSafeInteger(deliveredA.activatedAt), true);

          // 2. Hold the activation IPC for a real click on link B
          holdB = armActivationHold(
            (_event, args) => args[0] === EXTERNAL_LINK_B_URL,
            "[t] held desktop:link-activated for link B",
          );
          await realClickElement(win, "external-link-b");
          const clickB = await waitForCondition(
            () => win.webContents.mainFrame.executeJavaScript("window.__tClickB && window.__tClickB.ran ? window.__tClickB : null"),
            "[t] link B click handler to run",
          );
          assert.equal(clickB.ran, true, "[t]: click on link B must run");
          assert.equal(clickB.isTrusted, true, "[t]: click on link B must be trusted");

          const heldB = await holdB.waitForHeld();
          assert.equal(heldB.url, EXTERNAL_LINK_B_URL, "[t]: held message must carry link B URL");
          assert.equal(Number.isSafeInteger(heldB.activatedAt), true);

          // 3. Script attempts B while A's ticket is still live -> refused, burns A's ticket, records refusal
          navPromiseB1 = waitForEvent(
            win.webContents,
            "will-frame-navigate",
            (details) => details.isMainFrame && details.url === EXTERNAL_LINK_B_URL,
          );
          await win.webContents.mainFrame.executeJavaScript(
            `window.location.href = ${JSON.stringify(EXTERNAL_LINK_B_URL)}`,
          );
          const [navDetailsB1] = await navPromiseB1;
          assert.ok(
            Date.now() - deliveredA.activatedAt < LINK_TICKET_WINDOW_MS,
            "[t]: first script attempt to B must occur while link A's ticket is still live",
          );
          assert.equal(navDetailsB1.defaultPrevented, true, "[t]: first script attempt to B must be cancelled");
          assert.equal(openedExternalUrls.length, 0, "[t]: first script attempt to B must open nothing");

          // 4. Release B's held activation into the registered production handler inside 1s lifetime
          assert.ok(
            Date.now() - heldB.activatedAt < LINK_TICKET_WINDOW_MS,
            "[t]: release of B's activation must stay inside 1s ticket lifetime",
          );
          heldB.release();

          // 5. Script attempts B again inside 1s of B's click -> still refused, nothing opens
          navPromiseB2 = waitForEvent(
            win.webContents,
            "will-frame-navigate",
            (details) => details.isMainFrame && details.url === EXTERNAL_LINK_B_URL,
          );
          await win.webContents.mainFrame.executeJavaScript(
            `window.location.href = ${JSON.stringify(EXTERNAL_LINK_B_URL)}`,
          );
          const [navDetailsB2] = await navPromiseB2;
          const elapsedFromB = Date.now() - heldB.activatedAt;
          assert.ok(
            elapsedFromB < LINK_TICKET_WINDOW_MS,
            `[t]: second script attempt to B (${elapsedFromB}ms) must stay inside ${LINK_TICKET_WINDOW_MS}ms lifetime`,
          );
          await sleep(150);

          assert.equal(navDetailsB2.defaultPrevented, true, "[t]: second script attempt to B after released activation must be cancelled");
          assert.equal(
            openedExternalUrls.length,
            0,
            `[t]: delayed activation for B after refusal must open nothing, got ${JSON.stringify(openedExternalUrls)}`,
          );
          assert.equal(win.webContents.getURL(), appUrl);

          // 6. Positive control: a genuinely fresh click on link B after the refusal opens once
          await realClickElement(win, "external-link-b");
          await waitForCondition(
            () => openedExternalUrls.length > 0,
            "[t] fresh click on link B after refusal to open once",
          );
          await sleep(100);
          assert.deepEqual(
            openedExternalUrls,
            [EXTERNAL_LINK_B_URL],
            `[t]: fresh click on link B after refusal must open once, got ${JSON.stringify(openedExternalUrls)}`,
          );
          assert.equal(win.webContents.getURL(), appUrl);
        } finally {
          deliveredAPromise.cancel();
          if (holdB) holdB.disarm();
          if (navPromiseB1) navPromiseB1.cancel();
          if (navPromiseB2) navPromiseB2.cancel();
          await win.webContents.mainFrame.executeJavaScript(`(() => {
            const linkA = document.getElementById("external-link");
            const linkB = document.getElementById("external-link-b");
            if (linkA && window.__tListenerA) linkA.removeEventListener("click", window.__tListenerA);
            if (linkB && window.__tListenerB) linkB.removeEventListener("click", window.__tListenerB);
            window.__tListenerA = null;
            window.__tListenerB = null;
          })()`).catch(() => {});
        }
      },
    );

    // (u) Stale activation held past ticket lifetime opens nothing
    await runCheck(
      "u",
      "activation IPC held longer than ticket lifetime and released into registered handler opens nothing",
      async () => {
        assert.equal(win.webContents.mainFrame.frames.length, 0);
        openedExternalUrls.length = 0;

        await win.webContents.mainFrame.executeJavaScript(`(() => {
          const link = document.getElementById("external-link");
          window.__uClick = { ran: false, isTrusted: null };
          window.__uListener = (event) => {
            event.preventDefault();
            window.__uClick = { ran: true, isTrusted: event.isTrusted === true };
          };
          link.addEventListener("click", window.__uListener, { once: true });
        })()`);

        const hold = armActivationHold(
          (_event, args) => args[0] === EXTERNAL_LINK_URL,
          "[u] held desktop:link-activated for link A",
        );
        let navPromise = null;
        try {
          await realClickElement(win, "external-link");
          const uClick = await waitForCondition(
            () => win.webContents.mainFrame.executeJavaScript("window.__uClick && window.__uClick.ran ? window.__uClick : null"),
            "[u] external-link click handler to run",
          );
          assert.equal(uClick.ran, true, "[u]: click on external-link must run");
          assert.equal(uClick.isTrusted, true, "[u]: click on external-link must be trusted");

          const heldEntry = await hold.waitForHeld();
          assert.equal(heldEntry.url, EXTERNAL_LINK_URL, "[u]: held message must carry link A URL");
          assert.equal(Number.isSafeInteger(heldEntry.activatedAt), true);

          await sleep(LINK_TICKET_WINDOW_MS + 100);
          const ageAtRelease = Date.now() - heldEntry.activatedAt;
          assert.ok(
            ageAtRelease >= LINK_TICKET_WINDOW_MS,
            `[u]: held activation age (${ageAtRelease}ms) must exceed ${LINK_TICKET_WINDOW_MS}ms lifetime before release`,
          );

          // Deliver the stale message into the registered production handler.
          heldEntry.release();

          navPromise = waitForEvent(
            win.webContents,
            "will-frame-navigate",
            (details) => details.isMainFrame && details.url === EXTERNAL_LINK_URL,
          );
          await win.webContents.mainFrame.executeJavaScript(
            `window.location.href = ${JSON.stringify(EXTERNAL_LINK_URL)}`,
          );
          const [navDetails] = await navPromise;
          await sleep(150);

          assert.equal(navDetails.defaultPrevented, true, "[u]: navigation after stale activation release must be cancelled");
          assert.equal(
            openedExternalUrls.length,
            0,
            `[u]: stale activation must open nothing, got ${JSON.stringify(openedExternalUrls)}`,
          );
          assert.equal(win.webContents.getURL(), appUrl);
        } finally {
          hold.disarm();
          if (navPromise) navPromise.cancel();
          await win.webContents.mainFrame.executeJavaScript(`(() => {
            const link = document.getElementById("external-link");
            if (link && window.__uListener) link.removeEventListener("click", window.__uListener);
            window.__uListener = null;
          })()`).catch(() => {});
        }
      },
    );

    // -------------------------------------------------------------------------
    // Phase 2: Same-origin subframe check (r)
    // -------------------------------------------------------------------------
    await runCheck(
      "r",
      "same-origin subframe: real click on external link and top-frame navigation open nothing",
      async () => {
        await attachIframe(win, "same-origin-subframe", `${appSrv.origin}/same-origin-subframe`);
        try {
          const sameOriginFrame = await waitForCondition(
            () => win.webContents.mainFrame.frames.find((f) => !f.isDestroyed() && f.origin === appSrv.origin),
            "same-origin subframe",
          );

          // Part 1: real click on external target="_blank" link inside same-origin iframe
          openedExternalUrls.length = 0;
          await sameOriginFrame.executeJavaScript(`(() => {
            const link = document.getElementById("so-ext-blank");
            window.__r1Click = { ran: false, isTrusted: null };
            link.addEventListener("click", (event) => {
              window.__r1Click = { ran: true, isTrusted: event.isTrusted === true };
            }, { once: true });
          })()`);

          const openPromise = waitForWindowOpenAttempt(
            (attempt) => attempt.url === SAME_ORIGIN_SUBFRAME_EXT_URL,
            `[r] part 1 setWindowOpenHandler for ${SAME_ORIGIN_SUBFRAME_EXT_URL}`,
          );
          try {
            const blankCoords = await getSubframeElementCenter(
              win,
              "same-origin-subframe",
              sameOriginFrame,
              "so-ext-blank",
            );
            await sendMouseClickAt(win, blankCoords, "left");
            const r1Click = await waitForCondition(
              () => sameOriginFrame.executeJavaScript("window.__r1Click && window.__r1Click.ran ? window.__r1Click : null"),
              "[r] part 1 same-origin subframe blank link click",
            );
            assert.equal(r1Click.ran, true);
            assert.equal(r1Click.isTrusted, true, "[r] part 1: click on so-ext-blank must be trusted");

            const openAttempt = await openPromise;
            await sleep(150);

            assert.equal(openAttempt.action, "deny", "[r] part 1: same-origin subframe window.open must be denied");
            assert.equal(BrowserWindow.getAllWindows().length, 1, "no child BrowserWindow may be created");
            assert.equal(openedExternalUrls.length, 0, "same-origin subframe external click must open nothing");
            assert.equal(win.webContents.getURL(), appUrl);
          } finally {
            openPromise.cancel();
          }

          // Part 2: real click on target="_top" external link inside same-origin iframe
          openedExternalUrls.length = 0;
          await sameOriginFrame.executeJavaScript(`(() => {
            const link = document.getElementById("so-ext-top");
            window.__r2Click = { ran: false, isTrusted: null };
            link.addEventListener("click", (event) => {
              window.__r2Click = { ran: true, isTrusted: event.isTrusted === true };
            }, { once: true });
          })()`);

          const navPromise = waitForEvent(
            win.webContents,
            "will-frame-navigate",
            (details) => details.isMainFrame && details.url === SAME_ORIGIN_SUBFRAME_TOP_URL,
          );
          try {
            const topCoords = await getSubframeElementCenter(
              win,
              "same-origin-subframe",
              sameOriginFrame,
              "so-ext-top",
            );
            await sendMouseClickAt(win, topCoords, "left");
            const r2Click = await waitForCondition(
              () => sameOriginFrame.executeJavaScript("window.__r2Click && window.__r2Click.ran ? window.__r2Click : null"),
              "[r] part 2 same-origin subframe top link click",
            );
            assert.equal(r2Click.ran, true);
            assert.equal(r2Click.isTrusted, true, "[r] part 2: click on so-ext-top must be trusted");

            const [navDetails] = await navPromise;
            await sleep(150);

            assert.equal(navDetails.defaultPrevented, true, "same-origin subframe top-frame nav must be cancelled");
            assert.equal(openedExternalUrls.length, 0, "same-origin subframe top-frame nav must open nothing");
            assert.equal(win.webContents.getURL(), appUrl);
          } finally {
            navPromise.cancel();
          }
        } finally {
          await removeIframe(win, "same-origin-subframe");
        }
      },
    );

    // -------------------------------------------------------------------------
    // Phase 3: Foreign subframe checks (a, e, f, g, p)
    // -------------------------------------------------------------------------

    // (a) Subframe navigating and redirecting to a foreign origin opens nothing and leaves main frame untouched
    await runCheck(
      "a",
      "subframe navigation and redirect to foreign origin opens nothing and keeps main frame on app",
      async () => {
        openedExternalUrls.length = 0;

        const navPromise = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => !details.isMainFrame && details.url === `${foreign.origin}/subframe-start`,
        );
        await attachIframe(win, "subframe", `${foreign.origin}/subframe-start`);
        const [navDetails] = await navPromise;
        assert.equal(navDetails.defaultPrevented, false, "subframe navigate should not be cancelled by top-level policy");

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
          (details) => details.isMainFrame && details.url === SIGN_IN_FIRST_URL,
        );
        await foreignFrame.executeJavaScript(
          `window.top.location.href = ${JSON.stringify(SIGN_IN_FIRST_URL)}`,
          true,
        );
        const [navDetails] = await navPromise;
        await sleep(150);

        assert.equal(navDetails.defaultPrevented, true, "subframe-initiated main-frame navigation must be cancelled");
        assert.equal(openedExternalUrls.length, 0, `expected 0 external opens, got ${JSON.stringify(openedExternalUrls)}`);
        assert.equal(win.webContents.getURL(), appUrl, "main frame URL should stay on appUrl");
      },
    );

    // (g) With a foreign subframe attached, a real click on inert button in main frame followed by
    //     subframe calling window.open(..., "_blank", "noreferrer") opens nothing
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
          const btn = document.getElementById("inert-button");
          window.__gState = { ran: false, isTrusted: null };
          window.__gListener = (event) => {
            window.__gState = { ran: true, isTrusted: event.isTrusted === true };
          };
          btn.addEventListener("click", window.__gListener, { once: true });
        })()`);

        const openPromise = waitForWindowOpenAttempt(
          (attempt) => attempt.url === SUBFRAME_WINDOW_OPEN_URL,
          `[g] setWindowOpenHandler for ${SUBFRAME_WINDOW_OPEN_URL}`,
        );
        try {
          await realClickElement(win, "inert-button");
          const gState = await waitForCondition(
            () => win.webContents.mainFrame.executeJavaScript("window.__gState && window.__gState.ran ? window.__gState : null"),
            "[g] inert-button click handler to run",
          );
          assert.equal(gState.ran, true);
          assert.equal(gState.isTrusted, true, "[g]: click on inert-button must be trusted");

          await foreignFrame.executeJavaScript(
            `window.open(${JSON.stringify(SUBFRAME_WINDOW_OPEN_URL)}, "_blank", "noreferrer")`,
            true,
          );
          const openAttempt = await openPromise;
          await sleep(150);

          assert.equal(openAttempt.action, "deny", "[g]: subframe window.open must be denied by setWindowOpenHandler");
          assert.equal(BrowserWindow.getAllWindows().length, 1, "no child BrowserWindow may be created");
          assert.equal(openedExternalUrls.length, 0, `expected 0 external opens, got ${JSON.stringify(openedExternalUrls)}`);
          assert.equal(win.webContents.getURL(), appUrl, "main frame URL should stay on appUrl");
        } finally {
          openPromise.cancel();
          await win.webContents.mainFrame.executeJavaScript(`(() => {
            const btn = document.getElementById("inert-button");
            if (btn && window.__gListener) btn.removeEventListener("click", window.__gListener);
            window.__gListener = null;
          })()`).catch(() => {});
        }
      },
    );

    // (p) Foreign-origin subframe cannot issue a ticket: real click on links inside foreign subframe
    //     opens nothing and leaves main frame in place
    await runCheck(
      "p",
      "foreign-origin subframe cannot issue a ticket; real click opens nothing and keeps main frame in place",
      async () => {
        await attachIframe(win, "subframe", `${foreign.origin}/subframe-links`);
        const foreignFrame = await waitForCondition(
          () => win.webContents.mainFrame.frames.find((f) => !f.isDestroyed() && f.url === `${foreign.origin}/subframe-links`),
          "foreign links subframe",
        );

        openedExternalUrls.length = 0;

        // Real click on target="_top" external link inside foreign subframe
        await foreignFrame.executeJavaScript(`(() => {
          const link = document.getElementById("foreign-ext-top");
          window.__p1Click = { ran: false, isTrusted: null };
          link.addEventListener("click", (event) => {
            window.__p1Click = { ran: true, isTrusted: event.isTrusted === true };
          }, { once: true });
        })()`);

        const navPromise = waitForEvent(
          win.webContents,
          "will-frame-navigate",
          (details) => details.isMainFrame && details.url === FOREIGN_SUBFRAME_EXT_URL,
        );
        try {
          const topCoords = await getSubframeElementCenter(win, "subframe", foreignFrame, "foreign-ext-top");
          await sendMouseClickAt(win, topCoords, "left");
          const p1Click = await waitForCondition(
            () => foreignFrame.executeJavaScript("window.__p1Click && window.__p1Click.ran ? window.__p1Click : null"),
            "[p] part 1 foreign subframe top link click",
          );
          assert.equal(p1Click.ran, true);
          assert.equal(p1Click.isTrusted, true, "[p] part 1: click on foreign-ext-top must be trusted");

          const [navDetails] = await navPromise;
          await sleep(150);

          assert.equal(navDetails.defaultPrevented, true, "foreign subframe top-frame nav must be cancelled");
          assert.equal(openedExternalUrls.length, 0);
          assert.equal(win.webContents.getURL(), appUrl);
        } finally {
          navPromise.cancel();
        }

        // Real click on target="_blank" external link inside foreign subframe
        openedExternalUrls.length = 0;
        await foreignFrame.executeJavaScript(`(() => {
          const link = document.getElementById("foreign-ext-blank");
          window.__p2Click = { ran: false, isTrusted: null };
          link.addEventListener("click", (event) => {
            window.__p2Click = { ran: true, isTrusted: event.isTrusted === true };
          }, { once: true });
        })()`);

        const openPromise = waitForWindowOpenAttempt(
          (attempt) => attempt.url === FOREIGN_SUBFRAME_EXT_URL,
          `[p] part 2 setWindowOpenHandler for ${FOREIGN_SUBFRAME_EXT_URL}`,
        );
        try {
          const blankCoords = await getSubframeElementCenter(win, "subframe", foreignFrame, "foreign-ext-blank");
          await sendMouseClickAt(win, blankCoords, "left");
          const p2Click = await waitForCondition(
            () => foreignFrame.executeJavaScript("window.__p2Click && window.__p2Click.ran ? window.__p2Click : null"),
            "[p] part 2 foreign subframe blank link click",
          );
          assert.equal(p2Click.ran, true);
          assert.equal(p2Click.isTrusted, true, "[p] part 2: click on foreign-ext-blank must be trusted");

          const openAttempt = await openPromise;
          await sleep(150);

          assert.equal(openAttempt.action, "deny", "[p] part 2: foreign subframe window.open must be denied");
          assert.equal(BrowserWindow.getAllWindows().length, 1, "no child BrowserWindow may be created");
          assert.equal(openedExternalUrls.length, 0);
          assert.equal(win.webContents.getURL(), appUrl);
        } finally {
          openPromise.cancel();
        }
      },
    );
  } catch (error) {
    failed = true;
    console.error(`FAIL [fatal] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  } finally {
    clearTimeout(globalTimeout);
    try {
      shell.openExternal = originalOpenExternal;
    } catch {
      // Ignore restore failure during shutdown.
    }
    try {
      ipcMain.on = originalIpcMainOn;
      ipcMain.off = originalIpcMainOff;
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
    const passedCount = results.filter((r) => r.ok).length;
    const totalCount = results.length;
    const exitCode = failed || totalCount === 0 || passedCount !== totalCount ? 1 : 0;
    console.log(`${passedCount} of ${totalCount} passed`);
    process.exitCode = exitCode;
    // Use app.exit(exitCode) directly because app.quit() ignores process.exitCode and exits 0.
    app.exit(exitCode);
  }
}

main().catch((error) => {
  failed = true;
  console.error(`FAIL [fatal] ${error instanceof Error ? error.stack || error.message : String(error)}`);
  const passedCount = results.filter((r) => r.ok).length;
  console.log(`${passedCount} of ${results.length} passed`);
  app.exit(1);
});

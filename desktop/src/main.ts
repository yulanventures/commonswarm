import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  Menu,
  screen,
  type MenuItemConstructorOptions,
} from "electron";
import {
  attachWindowHandlers,
  configurePermissions,
  openExternalSafely,
} from "./handlers.js";
import {
  getAllowedDevOrigin,
  HELP_URL,
  resolveAppUrl,
  type AppOriginOptions,
} from "./policy.js";

const APP_TITLE = "CommonSwarm";
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 840;
const MIN_WIDTH = 720;
const MIN_HEIGHT = 540;
const ERR_ABORTED = -3;

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const offlinePagePath = path.resolve(currentDir, "..", "static", "offline.html");
const offlinePageUrl = pathToFileURL(offlinePagePath).href;

let mainWindow: BrowserWindow | null = null;

function windowStatePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

function isRectVisibleOnAnyDisplay(x: number, y: number, width: number, height: number): boolean {
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapX = Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x);
    const overlapY = Math.min(y + height, workArea.y + workArea.height) - Math.max(y, workArea.y);
    return overlapX >= 100 && overlapY >= 100;
  });
}

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  try {
    const raw = fs.readFileSync(windowStatePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    const width =
      typeof parsed.width === "number" && Number.isFinite(parsed.width) && parsed.width >= MIN_WIDTH
        ? Math.round(parsed.width)
        : DEFAULT_WIDTH;
    const height =
      typeof parsed.height === "number" && Number.isFinite(parsed.height) && parsed.height >= MIN_HEIGHT
        ? Math.round(parsed.height)
        : DEFAULT_HEIGHT;
    const state: WindowState = {
      width,
      height,
      isMaximized: parsed.isMaximized === true,
    };
    if (
      typeof parsed.x === "number" &&
      Number.isFinite(parsed.x) &&
      typeof parsed.y === "number" &&
      Number.isFinite(parsed.y) &&
      isRectVisibleOnAnyDisplay(parsed.x, parsed.y, width, height)
    ) {
      state.x = Math.round(parsed.x);
      state.y = Math.round(parsed.y);
    }
    return state;
  } catch {
    return fallback;
  }
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    const isMaximized = win.isMaximized();
    const bounds = win.getNormalBounds();
    const state: WindowState = {
      width: Math.max(MIN_WIDTH, bounds.width),
      height: Math.max(MIN_HEIGHT, bounds.height),
      x: bounds.x,
      y: bounds.y,
      isMaximized,
    };
    fs.mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    fs.writeFileSync(windowStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Persisting bounds is best-effort; never block closing or resizing.
  }
}

function buildAppMenu(): Menu {
  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: "reload" },
    { role: "forceReload" },
  ];
  if (!app.isPackaged) {
    viewSubmenu.push({ role: "toggleDevTools" });
  }
  viewSubmenu.push(
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  );

  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_TITLE,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: viewSubmenu,
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "CommonSwarm Help",
          click: () => openExternalSafely(HELP_URL),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

function createMainWindow(appUrl: string, policyOptions: AppOriginOptions): BrowserWindow {
  const saved = loadWindowState();

  const win = new BrowserWindow({
    title: APP_TITLE,
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    titleBarStyle: "default",
    backgroundColor: "#111317",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });

  if (saved.isMaximized) {
    win.maximize();
  }

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      saveWindowState(win);
    }, 250);
  };

  win.on("resize", scheduleSave);
  win.on("move", scheduleSave);
  win.on("close", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    saveWindowState(win);
  });
  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.show();
    }
  });

  const loadOfflinePage = (): void => {
    if (win.isDestroyed()) return;
    void win
      .loadFile(offlinePagePath, { query: { target: appUrl } })
      .then(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.show();
      })
      .catch(() => {});
  };

  attachWindowHandlers(win, policyOptions, { offlinePageUrl });

  win.webContents.on("did-fail-load", (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    if (validatedURL.startsWith("file:")) return;
    loadOfflinePage();
  });

  win.loadURL(appUrl).catch((error: unknown) => {
    const code = (error as { errno?: number; code?: string } | null)?.errno;
    if (code === ERR_ABORTED) return;
    loadOfflinePage();
  });

  mainWindow = win;
  return win;
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.setName(APP_TITLE);

  const appUrl = resolveAppUrl({ isPackaged: app.isPackaged, env: process.env });
  const policyOptions: AppOriginOptions = {
    allowedDevOrigin: getAllowedDevOrigin(appUrl, app.isPackaged),
  };

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  });

  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (app.isReady()) {
      createMainWindow(appUrl, policyOptions);
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(appUrl, policyOptions);
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    configurePermissions(policyOptions);
    Menu.setApplicationMenu(buildAppMenu());
    createMainWindow(appUrl, policyOptions);
  });
}

export type DividerId = "rail" | "side" | "wiki" | "people" | "lists";

export interface DividerSpec {
  id: DividerId;
  label: string;
  prop: string;
  defaultPx: number;
  minPx: number;
  maxPx: number;
  minRemainPx: number;
  direction: "start" | "end";
  resolveHost: (app: HTMLElement, shellRoot: HTMLElement | null) => HTMLElement | null;
  insertInto: (host: HTMLElement, handle: HTMLElement) => void;
}

const STORAGE_PREFIX = "cs-divider-width:";
const KEYBOARD_STEP = 16;
const KEYBOARD_LARGE_STEP = 48;

export const RESIZER_SPECS: readonly DividerSpec[] = [
  {
    id: "rail",
    label: "Resize workspace sidebar",
    prop: "--cs-rail-width",
    defaultPx: 260,
    minPx: 200,
    maxPx: 440,
    minRemainPx: 260,
    direction: "start",
    resolveHost: (_app, shellRoot) => shellRoot,
    insertInto: (host, handle) => {
      const dialog = host.querySelector(":scope > dialog.cs-org-drawer");
      if (dialog) host.insertBefore(handle, dialog);
      else host.append(handle);
    },
  },
  {
    id: "side",
    label: "Resize details panel",
    prop: "--cs-side-width",
    defaultPx: 288,
    minPx: 220,
    maxPx: 520,
    minRemainPx: 260,
    direction: "end",
    resolveHost: (app) => app.querySelector<HTMLElement>(".hm-frame"),
    insertInto: (host, handle) => host.append(handle),
  },
  {
    id: "wiki",
    label: "Resize wiki pages list",
    prop: "--cs-wiki-index-width",
    defaultPx: 260,
    minPx: 180,
    maxPx: 460,
    minRemainPx: 240,
    direction: "start",
    resolveHost: (app) => app.querySelector<HTMLElement>(".dashboard__brain-view"),
    insertInto: (host, handle) => host.append(handle),
  },
  {
    id: "people",
    label: "Resize people and agents list",
    prop: "--cs-people-list-width",
    defaultPx: 340,
    minPx: 240,
    maxPx: 520,
    minRemainPx: 240,
    direction: "start",
    resolveHost: (app) => app.querySelector<HTMLElement>("[data-people-page]"),
    insertInto: (host, handle) => host.append(handle),
  },
  {
    id: "lists",
    label: "Resize lists sidebar",
    prop: "--cs-lists-nav-width",
    defaultPx: 220,
    minPx: 160,
    maxPx: 420,
    minRemainPx: 240,
    direction: "start",
    resolveHost: (app) => app.querySelector<HTMLElement>(".household-objects .hh-layout"),
    insertInto: (host, handle) => host.append(handle),
  },
];

export function clampResizerWidth(value: number, min: number, max: number): number {
  const safeMax = Math.max(min, max);
  return Math.round(Math.min(safeMax, Math.max(min, value)));
}

function readStoredWidth(win: Window | null, spec: DividerSpec): number {
  try {
    const raw = win?.localStorage?.getItem(`${STORAGE_PREFIX}${spec.id}`);
    if (!raw) return spec.defaultPx;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? clampResizerWidth(parsed, spec.minPx, spec.maxPx) : spec.defaultPx;
  } catch {
    return spec.defaultPx;
  }
}

function writeStoredWidth(win: Window | null, spec: DividerSpec, value: number): void {
  try {
    if (value === spec.defaultPx) win?.localStorage?.removeItem(`${STORAGE_PREFIX}${spec.id}`);
    else win?.localStorage?.setItem(`${STORAGE_PREFIX}${spec.id}`, String(value));
  } catch {
    /* Storage may be unavailable in restricted contexts. */
  }
}

export function createShellResizers(app: HTMLElement, getShellRoot: () => HTMLElement | null) {
  const doc = app.ownerDocument;
  const win = doc.defaultView;
  const handles = new Map<DividerId, HTMLElement>();
  const values = new Map<DividerId, number>();
  const teardowns: Array<() => void> = [];
  let observing = false;

  const effectiveMaxPx = (spec: DividerSpec, host: HTMLElement | null): number => {
    const hostWidth = host?.clientWidth ?? 0;
    if (hostWidth <= 0) return spec.maxPx;
    let extraReserve = 0;
    if (spec.id === "rail") {
      const side = app.querySelector<HTMLElement>(".hm-frame > .hm-frame__side:not([hidden]), .hm-frame > .hm-frame__profile:not([hidden])");
      const sideWidth = side?.getBoundingClientRect().width ?? 0;
      if (sideWidth > 0) extraReserve = sideWidth;
    }
    return Math.max(spec.minPx, Math.min(spec.maxPx, Math.floor(hostWidth - spec.minRemainPx - extraReserve)));
  };

  const applyValue = (spec: DividerSpec, nextValue: number, persist = true): number => {
    const shellRoot = getShellRoot();
    const host = spec.resolveHost(app, shellRoot);
    const maxPx = effectiveMaxPx(spec, host);
    const clamped = clampResizerWidth(nextValue, spec.minPx, maxPx);
    values.set(spec.id, clamped);
    const handle = handles.get(spec.id);
    if (handle) {
      handle.setAttribute("aria-valuemax", String(maxPx));
      handle.setAttribute("aria-valuenow", String(clamped));
      if (host) host.style.setProperty(spec.prop, `${clamped}px`);
    }
    app.style.setProperty(spec.prop, `${clamped}px`);
    if (persist) writeStoredWidth(win, spec, clamped);
    return clamped;
  };

  const syncAll = () => {
    const shellRoot = getShellRoot();
    if (!shellRoot) return;
    for (const spec of RESIZER_SPECS) {
      const handle = handles.get(spec.id);
      if (!handle) continue;
      const host = spec.resolveHost(app, shellRoot);
      const maxPx = effectiveMaxPx(spec, host);
      const preferred = values.get(spec.id) ?? spec.defaultPx;
      const current = clampResizerWidth(preferred, spec.minPx, maxPx);
      handle.setAttribute("aria-valuemax", String(maxPx));
      handle.setAttribute("aria-valuenow", String(current));
      app.style.setProperty(spec.prop, `${current}px`);
      if (!host) {
        if (handle.parentElement) handle.remove();
        continue;
      }
      host.style.setProperty(spec.prop, `${current}px`);
      if (handle.parentElement !== host) {
        spec.insertInto(host, handle);
      }
    }
  };

  const mutationObserver = typeof MutationObserver !== "undefined"
    ? new MutationObserver((records) => {
        const onlyResizer = records.every((record) => {
          const nodes = [...record.addedNodes, ...record.removedNodes];
          return nodes.length > 0 && nodes.every((node) => node instanceof HTMLElement && node.classList.contains("cs-resizer"));
        });
        if (onlyResizer) return;
        syncAll();
      })
    : null;

  const onWindowResize = () => syncAll();

  const startObserving = () => {
    if (observing) return;
    observing = true;
    mutationObserver?.observe(app, { childList: true, subtree: true });
    win?.addEventListener("resize", onWindowResize);
  };

  const stopObserving = () => {
    if (!observing) return;
    observing = false;
    mutationObserver?.disconnect();
    win?.removeEventListener("resize", onWindowResize);
  };

  for (const spec of RESIZER_SPECS) {
    const initial = readStoredWidth(win, spec);
    values.set(spec.id, initial);
    const handle = doc.createElement("div");
    handle.className = `cs-resizer cs-resizer--${spec.id}`;
    handle.dataset.resizer = spec.id;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", spec.label);
    handle.setAttribute("aria-valuemin", String(spec.minPx));
    handle.setAttribute("aria-valuemax", String(spec.maxPx));
    handle.setAttribute("aria-valuenow", String(initial));
    handle.tabIndex = 0;

    let dragState: { pointerId: number; startX: number; startWidth: number } | null = null;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const shellRoot = getShellRoot();
      const host = spec.resolveHost(app, shellRoot);
      const current = clampResizerWidth(values.get(spec.id) ?? spec.defaultPx, spec.minPx, effectiveMaxPx(spec, host));
      dragState = { pointerId: event.pointerId, startX: event.clientX, startWidth: current };
      handle.dataset.dragging = "";
      doc.documentElement.dataset.csResizing = spec.id;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* Synthetic events in headless tests may not have an active pointerId. */
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      const delta = (event.clientX - dragState.startX) * (spec.direction === "start" ? 1 : -1);
      applyValue(spec, dragState.startWidth + delta, true);
    };

    const finishDrag = (event: PointerEvent) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      dragState = null;
      delete handle.dataset.dragging;
      delete doc.documentElement.dataset.csResizing;
      try {
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      } catch {
        /* Ignore synthetic pointer capture release errors. */
      }
    };

    const onDblClick = (event: MouseEvent) => {
      event.preventDefault();
      applyValue(spec, spec.defaultPx, true);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const shellRoot = getShellRoot();
      const host = spec.resolveHost(app, shellRoot);
      const maxPx = effectiveMaxPx(spec, host);
      const current = clampResizerWidth(values.get(spec.id) ?? spec.defaultPx, spec.minPx, maxPx);
      const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
      const sign = spec.direction === "start" ? 1 : -1;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        applyValue(spec, current + step * sign, true);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        applyValue(spec, current - step * sign, true);
      } else if (event.key === "Home") {
        event.preventDefault();
        applyValue(spec, spec.minPx, true);
      } else if (event.key === "End") {
        event.preventDefault();
        applyValue(spec, maxPx, true);
      } else if (event.key === "Enter") {
        event.preventDefault();
        applyValue(spec, spec.defaultPx, true);
      }
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.addEventListener("pointermove", onPointerMove);
    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);
    handle.addEventListener("dblclick", onDblClick);
    handle.addEventListener("keydown", onKeyDown);

    teardowns.push(() => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", finishDrag);
      handle.removeEventListener("pointercancel", finishDrag);
      handle.removeEventListener("dblclick", onDblClick);
      handle.removeEventListener("keydown", onKeyDown);
      handle.remove();
    });

    handles.set(spec.id, handle);
  }

  const suspend = () => {
    stopObserving();
    delete doc.documentElement.dataset.csResizing;
    const shellRoot = getShellRoot();
    for (const spec of RESIZER_SPECS) {
      app.style.removeProperty(spec.prop);
      const host = spec.resolveHost(app, shellRoot);
      host?.style.removeProperty(spec.prop);
      handles.get(spec.id)?.remove();
    }
  };

  return {
    sync() {
      startObserving();
      syncAll();
    },
    suspend,
    destroy() {
      suspend();
      for (const teardown of teardowns) teardown();
    },
  };
}

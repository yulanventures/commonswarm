/**
 * The chat picture viewer: one picture, whole and close up, over the conversation.
 *
 * This module is fetched the first time a picture is opened, so none of it is in the app's starting JavaScript.
 * The signed link only ever becomes the image's src: no fetch, blob or CORS (chat-image-preview.test.mjs).
 *
 * The picture opens fitted to the window. Zoom, double click or double tap goes to its actual size and back; a pinch
 * (or Ctrl and the wheel, which is what a trackpad pinch sends) zooms about the fingers; a drag or the wheel pans
 * while zoomed; `+`, `-`, `0` and the arrow keys do the same from the keyboard. Escape, Close, a press beside a fitted
 * picture, or a one-finger swipe down from fitted size closes it. Finishing a pan or a pinch never does.
 */
import { chatImagePreviewFailure } from "./chat-image-preview";

export interface Size { w: number; h: number }
export interface Point { x: number; y: number }
/** `scale` 1 is the fitted picture; `x` and `y` move it from the stage's centre, in CSS pixels. */
export interface View { scale: number; x: number; y: number }

export const FITTED: View = { scale: 1, x: 0, y: 0 };
/** How far a finger must travel before a press stops being a tap. */
const SLOP = 6;
/** How far down a fitted picture must be pulled for letting go to close the viewer. */
const PULL_TO_CLOSE = 96;

/** The picture's size when all of it fits the stage. A small picture is not blown up. */
export function fittedSize(natural: Size, stage: Size): Size {
  const factor = Math.min(1, stage.w / natural.w, stage.h / natural.h);
  return { w: natural.w * factor, h: natural.h * factor };
}

/** The scale the Zoom toggle goes to: one picture pixel per CSS pixel, or twice the size for a picture already shown at its own. */
export function closeUpScale(natural: Size, fitted: Size): number {
  const actual = natural.w / fitted.w;
  return actual > 1.05 ? actual : 2;
}

export function maxScale(natural: Size, fitted: Size): number {
  return Math.max(4, closeUpScale(natural, fitted) * 2);
}

/** Keeps the scale in range and the picture over the stage: where it is larger than the stage it cannot show a gap,
 *  and where it is smaller it stays centred. */
export function clampView(view: View, fitted: Size, stage: Size, max: number): View {
  const scale = Math.min(max, Math.max(1, view.scale));
  const reach = (size: number, room: number) => Math.max(0, (size * scale - room) / 2);
  const rx = reach(fitted.w, stage.w), ry = reach(fitted.h, stage.h);
  return { scale, x: Math.min(rx, Math.max(-rx, view.x)), y: Math.min(ry, Math.max(-ry, view.y)) };
}

/** Scales about a point, measured from the stage's centre, so that what is under the point stays under it. */
export function zoomAbout(view: View, scale: number, point: Point): View {
  const k = scale / view.scale;
  return { scale, x: point.x - (point.x - view.x) * k, y: point.y - (point.y - view.y) * k };
}

export interface PictureSource {
  name: string;
  /** A link for the picture: one already in use that has time left, else a newly signed one. */
  link: () => Promise<string>;
  /** The link last given failed: drop it, so the next one is signed anew. */
  forget: () => void;
  download: () => void;
}

const ICONS = {
  zoomIn: "M13 13l4 4M14 8.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0zM8.5 6.2v4.6M6.2 8.5h4.6",
  zoomOut: "M13 13l4 4M14 8.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0zM6.2 8.5h4.6",
  download: "M10 3v9M6.5 8.8L10 12.3l3.5-3.5M4 15.5h12",
  close: "M5 5l10 10M15 5L5 15",
} as const;

/** Opens the viewer inside `host` and returns its dialog. `closed` runs once it has gone, to put focus back. */
export function openImageViewer(host: HTMLElement, source: PictureSource, closed: () => void): HTMLDialogElement {
  const doc = host.ownerDocument, win = doc.defaultView!;
  const calm = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag); node.className = className; return node;
  };
  const control = (label: string, hook: string, path: string): HTMLButtonElement => {
    const button = el("button", "cs-viewer__button");
    button.type = "button"; button.dataset[hook] = ""; button.title = label; button.setAttribute("aria-label", label);
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("aria-hidden", "true");
    svg.append(doc.createElementNS("http://www.w3.org/2000/svg", "path"));
    svg.firstElementChild!.setAttribute("d", path);
    button.append(svg);
    return button;
  };

  const dialog = el("dialog", "cs-viewer");
  dialog.dataset.imageViewer = ""; dialog.tabIndex = -1; dialog.setAttribute("aria-label", source.name);
  const bar = el("header", "cs-viewer__bar");
  const name = el("p", "cs-viewer__name"); name.textContent = source.name;
  const zoom = control("Zoom", "viewerZoom", ICONS.zoomIn); zoom.setAttribute("aria-pressed", "false");
  const download = control("Download", "viewerDownload", ICONS.download);
  const close = control("Close", "viewerClose", ICONS.close); close.autofocus = true;
  bar.append(name, zoom, download, close);
  const stage = el("div", "cs-viewer__stage"); stage.dataset.viewerStage = "";
  const image = el("img", "cs-viewer__image");
  image.alt = source.name; image.draggable = false; image.decoding = "async"; image.referrerPolicy = "no-referrer";
  const note = el("p", "cs-viewer__note"); note.hidden = true;
  const said = el("span", ""); said.textContent = "Couldn't load image";
  const retry = el("button", ""); retry.type = "button"; retry.textContent = "Retry";
  retry.setAttribute("aria-label", `Retry loading ${source.name}`);
  note.append(said, retry);
  stage.append(image, note);
  dialog.append(bar, stage);

  let view = FITTED;
  let natural: Size | null = null;
  let fitted: Size = { w: 0, h: 0 };
  const stageSize = (): Size => ({ w: stage.clientWidth, h: stage.clientHeight });
  const zoomed = (): boolean => view.scale > 1.001;
  const draw = (ease = false): void => {
    dialog.toggleAttribute("data-easing", ease && !calm);
    dialog.toggleAttribute("data-zoomed", zoomed());
    dialog.style.removeProperty("--cs-viewer-pull");
    image.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`;
    zoom.setAttribute("aria-pressed", String(zoomed()));
    zoom.querySelector("path")!.setAttribute("d", zoomed() ? ICONS.zoomOut : ICONS.zoomIn);
  };
  /** `settle` is for the end of a movement: a picture left a hair above fitted size goes back to fitted. */
  const set = (next: View, options: { ease?: boolean; settle?: boolean } = {}): void => {
    if (natural) {
      view = clampView(next, fitted, stageSize(), maxScale(natural, fitted));
      if (options.settle && view.scale < 1.03) view = FITTED;
    }
    draw(options.ease);
  };
  const layout = (): void => {
    if (!natural) return;
    fitted = fittedSize(natural, stageSize());
    image.style.width = `${fitted.w}px`; image.style.height = `${fitted.h}px`;
    set(view, { settle: true });
  };
  const fromCentre = (point: Point): Point => {
    const box = stage.getBoundingClientRect();
    return { x: point.x - box.left - box.width / 2, y: point.y - box.top - box.height / 2 };
  };
  const toggle = (about: Point): void => {
    if (!natural) return;
    set(zoomed() ? FITTED : zoomAbout(view, closeUpScale(natural, fitted), about), { ease: true, settle: true });
  };

  // The picture is painted only once it has loaded, as in the conversation. One failed link is replaced; after that, Retry.
  let failures = 0;
  const show = (state: "loading" | "failed" | ""): void => { dialog.dataset.state = state; note.hidden = state !== "failed"; };
  const load = async (): Promise<void> => {
    show("loading");
    try { image.src = await source.link(); } catch { show("failed"); }
  };
  image.addEventListener("load", () => {
    natural = { w: image.naturalWidth, h: image.naturalHeight };
    show(""); layout();
  });
  image.addEventListener("error", () => {
    source.forget();
    if (chatImagePreviewFailure(failures++) === "retry") void load(); else show("failed");
  });
  retry.addEventListener("click", () => {
    // Retry goes away while the picture is tried again; focus stays in the viewer.
    if (doc.activeElement === retry) dialog.focus({ preventScroll: true });
    failures = 0;
    void load();
  });

  // Pointers. One finger pans a zoomed picture or pulls a fitted one down to close; two pinch. A gesture that has
  // pinched can no longer close the viewer, whatever its last finger does.
  const points = new Map<number, Point>();
  let gesture: { kind: "pan" | "pinch" | "pull" | "none"; from: View; at: Point; span: number; moved: boolean; pinched: boolean; pull: number } | null = null;
  let pressedOn: EventTarget | null = null;
  let lastTap: { at: number; point: Point } | null = null;
  const pair = (): { at: Point; span: number } => {
    const [a, b] = [...points.values()] as [Point, Point];
    return { at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, span: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };
  const begin = (touch: boolean): void => {
    const pinched = gesture?.pinched ?? false, moved = gesture?.moved ?? false;
    if (points.size >= 2) {
      const { at, span } = pair();
      gesture = { kind: "pinch", from: view, at, span, moved: true, pinched: true, pull: 0 };
    } else {
      const [at] = [...points.values()] as [Point];
      gesture = { kind: zoomed() ? "pan" : touch && !pinched ? "pull" : "none", from: view, at, span: 1, moved, pinched, pull: 0 };
    }
  };
  stage.addEventListener("pointerdown", (event) => {
    if ((event.pointerType === "mouse" && event.button !== 0) || (event.target as Element).closest("button")) return;
    if (points.size === 0) pressedOn = event.target;
    stage.setPointerCapture(event.pointerId);
    points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    begin(event.pointerType !== "mouse");
  });
  stage.addEventListener("pointermove", (event) => {
    if (!points.has(event.pointerId) || !gesture) return;
    const point = { x: event.clientX, y: event.clientY };
    points.set(event.pointerId, point);
    if (gesture.kind === "pinch" && points.size >= 2) {
      const { at, span } = pair();
      const next = zoomAbout(gesture.from, gesture.from.scale * span / gesture.span, fromCentre(gesture.at));
      set({ scale: next.scale, x: next.x + at.x - gesture.at.x, y: next.y + at.y - gesture.at.y });
      return;
    }
    const dx = point.x - gesture.at.x, dy = point.y - gesture.at.y;
    if (Math.hypot(dx, dy) > SLOP) gesture.moved = true;
    if (gesture.kind === "pan") set({ scale: gesture.from.scale, x: gesture.from.x + dx, y: gesture.from.y + dy });
    else if (gesture.kind === "pull" && gesture.moved) {
      gesture.pull = dy > 0 && dy > Math.abs(dx) ? dy : 0;
      dialog.removeAttribute("data-easing");
      image.style.transform = `translate3d(0, ${gesture.pull}px, 0)`;
      dialog.style.setProperty("--cs-viewer-pull", String(Math.min(1, gesture.pull / 320)));
    }
  });
  const lift = (event: PointerEvent): void => {
    const point = points.get(event.pointerId);
    if (!point) return;
    points.delete(event.pointerId);
    const ended = gesture;
    if (points.size > 0) { begin(event.pointerType !== "mouse"); return; }
    gesture = null;
    if (!ended) return;
    const lifted = event.type === "pointerup";
    if (lifted && ended.kind === "pull" && ended.pull > PULL_TO_CLOSE) { dialog.close(); return; }
    set(view, { ease: ended.kind === "pull" && ended.pull > 0, settle: true });
    if (!lifted || ended.moved || ended.pinched) { lastTap = null; return; }
    if (lastTap && event.timeStamp - lastTap.at < 320 && Math.hypot(point.x - lastTap.point.x, point.y - lastTap.point.y) < 28) {
      lastTap = null;
      toggle(fromCentre(point));
      return;
    }
    lastTap = { at: event.timeStamp, point };
    // A press beside a fitted picture closes the viewer. A press on the picture never does anything by itself.
    if (pressedOn === stage && !zoomed()) dialog.close();
  };
  stage.addEventListener("pointerup", lift);
  stage.addEventListener("pointercancel", lift);
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) set(zoomAbout(view, view.scale * Math.exp(-event.deltaY * 0.01), fromCentre({ x: event.clientX, y: event.clientY })), { settle: true });
    else if (zoomed()) set({ scale: view.scale, x: view.x - event.deltaX, y: view.y - event.deltaY });
  }, { passive: false });

  // Keys stay in the viewer: nothing behind it answers them. Escape is the dialog's own.
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const pan = zoomed() ? ({ ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] } as Record<string, [number, number]>)[event.key] : undefined;
    const next = event.key === "+" || event.key === "=" ? zoomAbout(view, view.scale * 1.5, { x: 0, y: 0 })
      : event.key === "-" ? zoomAbout(view, view.scale / 1.5, { x: 0, y: 0 })
      : event.key === "0" ? FITTED
      : pan ? { scale: view.scale, x: view.x + pan[0], y: view.y + pan[1] } : null;
    if (!next) return;
    event.preventDefault();
    set(next, { ease: true, settle: true });
  });

  zoom.addEventListener("click", () => toggle({ x: 0, y: 0 }));
  download.addEventListener("click", () => source.download());
  close.addEventListener("click", () => dialog.close());
  win.addEventListener("resize", layout);
  dialog.addEventListener("close", () => {
    win.removeEventListener("resize", layout);
    dialog.remove();
    closed();
  });

  host.append(dialog);
  dialog.showModal();
  void load();
  return dialog;
}

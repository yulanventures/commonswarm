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
 *
 * A message with several pictures opens on the one pressed and offers the others: Previous and Next, the left and
 * right arrow keys while the picture is fitted (they pan while it is zoomed), and a one-finger swipe sideways from
 * fitted size. Closing returns focus to the picture last shown.
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
/** How far sideways a fitted picture must be slid for letting go to show its neighbour. */
const SLIDE_TO_STEP = 64;

/** The picture a sideways slide of `dx` ends on: the next for a slide to the left, the previous for one to the right,
 *  and the same one when the slide is short or there is no neighbour that way. */
export function slideTarget(index: number, count: number, dx: number): number {
  if (Math.abs(dx) < SLIDE_TO_STEP) return index;
  return Math.min(count - 1, Math.max(0, index + (dx < 0 ? 1 : -1)));
}

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
  previous: "M12 4.5L6.5 10l5.5 5.5",
  next: "M8 4.5l5.5 5.5L8 15.5",
  download: "M10 3v9M6.5 8.8L10 12.3l3.5-3.5M4 15.5h12",
  close: "M5 5l10 10M15 5L5 15",
} as const;

/** Opens the viewer inside `host` on `sources[start]` and returns its dialog. `closed` runs once it has gone, with the
 *  index of the picture last shown, to put focus back on it. */
export function openImageViewer(host: HTMLElement, sources: readonly PictureSource[], start: number, closed: (index: number) => void): HTMLDialogElement {
  let index = Math.min(sources.length - 1, Math.max(0, start));
  let source = sources[index]!;
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
  dialog.dataset.imageViewer = ""; dialog.tabIndex = -1;
  const bar = el("header", "cs-viewer__bar");
  // The name says which picture this is, and with several, which of how many. The position keeps its own room so a
  // long filename truncates before it does, while the live region announces the full filename and position together.
  const name = el("p", "cs-viewer__name"); name.setAttribute("aria-live", "polite"); name.setAttribute("aria-atomic", "true");
  const title = el("span", "cs-viewer__title");
  const sep = el("span", "cs-viewer__sep"); sep.textContent = ", ";
  const position = el("span", "cs-viewer__position"); position.dataset.viewerPosition = "";
  name.append(title);
  if (sources.length > 1) name.append(sep, position);
  const zoom = control("Zoom", "viewerZoom", ICONS.zoomIn); zoom.setAttribute("aria-pressed", "false");
  const download = control("Download", "viewerDownload", ICONS.download);
  const close = control("Close", "viewerClose", ICONS.close); close.autofocus = true;
  bar.append(name, zoom, download, close);
  const stage = el("div", "cs-viewer__stage"); stage.dataset.viewerStage = "";
  const image = el("img", "cs-viewer__image");
  image.draggable = false; image.decoding = "async"; image.referrerPolicy = "no-referrer";
  const previous = control("Previous picture", "viewerPrevious", ICONS.previous); previous.classList.add("cs-viewer__step");
  const next = control("Next picture", "viewerNext", ICONS.next); next.classList.add("cs-viewer__step");
  const note = el("p", "cs-viewer__note"); note.hidden = true;
  const said = el("span", ""); said.textContent = "Couldn't load image";
  const retry = el("button", ""); retry.type = "button"; retry.textContent = "Retry";
  note.append(said, retry);
  stage.append(image, note);
  if (sources.length > 1) stage.append(previous, next);
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
    const asked = source;
    show("loading");
    // A link that arrives after the reader has moved to another picture belongs to nobody.
    try { const link = await asked.link(); if (asked === source) image.src = link; } catch { if (asked === source) show("failed"); }
  };
  /** Show `sources[to]`: named, fitted, and loading from its own link. */
  const present = (to: number): void => {
    index = to; source = sources[index]!;
    const of = sources.length > 1 ? `${index + 1} of ${sources.length}` : "";
    title.textContent = source.name;
    if (sources.length > 1) position.textContent = of;
    dialog.setAttribute("aria-label", of ? `${source.name}, ${of}` : source.name);
    image.alt = source.name;
    retry.setAttribute("aria-label", `Retry loading ${source.name}`);
    previous.disabled = index === 0; next.disabled = index === sources.length - 1;
    natural = null; view = FITTED; failures = 0;
    image.removeAttribute("src"); image.style.width = ""; image.style.height = "";
    draw();
    void load();
  };
  /** Step to a neighbour. A step taken from a control that then goes away (the last picture has no Next) keeps focus in the viewer. */
  const step = (by: number): void => {
    const to = Math.min(sources.length - 1, Math.max(0, index + by));
    if (to === index) return;
    present(to);
    if (doc.activeElement instanceof HTMLButtonElement && doc.activeElement.disabled) (by > 0 ? previous : next).focus({ preventScroll: true });
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
  let gesture: { kind: "pan" | "pinch" | "pull" | "none"; from: View; at: Point; span: number; moved: boolean; pinched: boolean; pull: number; slide: number } | null = null;
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
      gesture = { kind: "pinch", from: view, at, span, moved: true, pinched: true, pull: 0, slide: 0 };
    } else {
      const [at] = [...points.values()] as [Point];
      gesture = { kind: zoomed() ? "pan" : touch && !pinched ? "pull" : "none", from: view, at, span: 1, moved, pinched, pull: 0, slide: 0 };
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
      // One finger on a fitted picture: down pulls it shut; sideways slides to a neighbour, when there is one that way.
      gesture.pull = dy > 0 && dy > Math.abs(dx) ? dy : 0;
      gesture.slide = !gesture.pull && Math.abs(dx) > Math.abs(dy) && slideTarget(index, sources.length, dx < 0 ? -SLIDE_TO_STEP : SLIDE_TO_STEP) !== index ? dx : 0;
      dialog.removeAttribute("data-easing");
      image.style.transform = `translate3d(${gesture.slide}px, ${gesture.pull}px, 0)`;
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
    if (lifted && ended.kind === "pull" && slideTarget(index, sources.length, ended.slide) !== index) { lastTap = null; step(ended.slide < 0 ? 1 : -1); return; }
    set(view, { ease: ended.kind === "pull" && (ended.pull > 0 || ended.slide !== 0), settle: true });
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
  // A key press that opened the viewer (Enter on a picture link, whose click runs on keydown before
  // keypress) can deliver its trailing keypress/keyup to autofocused Close and shut the viewer at once.
  // Ignore trailing keypress/keyup (and initial key repeat) until a keydown starts inside this dialog.
  let keyInside = false;
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (!keyInside && event.repeat) { event.preventDefault(); return; }
    keyInside = true;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    // The arrow keys pan a zoomed picture. On a fitted one, left and right go to the neighbouring picture.
    if (!zoomed() && sources.length > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    const pan = zoomed() ? ({ ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] } as Record<string, [number, number]>)[event.key] : undefined;
    const next = event.key === "+" || event.key === "=" ? zoomAbout(view, view.scale * 1.5, { x: 0, y: 0 })
      : event.key === "-" ? zoomAbout(view, view.scale / 1.5, { x: 0, y: 0 })
      : event.key === "0" ? FITTED
      : pan ? { scale: view.scale, x: view.x + pan[0], y: view.y + pan[1] } : null;
    if (!next) return;
    event.preventDefault();
    set(next, { ease: true, settle: true });
  });
  dialog.addEventListener("keypress", (event) => {
    if (!keyInside) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  dialog.addEventListener("keyup", (event) => {
    if (!keyInside) { event.preventDefault(); event.stopPropagation(); }
  }, true);

  zoom.addEventListener("click", () => toggle({ x: 0, y: 0 }));
  previous.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  download.addEventListener("click", () => source.download());
  close.addEventListener("click", () => dialog.close());
  win.addEventListener("resize", layout);
  dialog.addEventListener("close", () => {
    win.removeEventListener("resize", layout);
    dialog.remove();
    closed(index);
  });

  host.append(dialog);
  dialog.showModal();
  present(index);
  return dialog;
}

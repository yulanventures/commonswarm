/**
 * Picture check for chat image attachments, in the real served app (seeded message: one PNG and one text file).
 * Signing and storage reads are held, failed or passed with page.route, so the check sees the frame before the
 * picture's link exists, before it loads, after it loads, when a first link fails, and when it cannot load at all,
 * and needs no production hook. In every state before it has loaded the picture must not be painted: that is what
 * keeps the browser's alt text and broken-picture mark off the screen. Every check that does not hold fails the audit.
 */
import { deflateSync } from "node:zlib";

export const AUDIT_PNG_SIZE = { width: 320, height: 200 } as const;

/** A real 320x200 RGB PNG (a gradient), built here so the seed needs no binary fixture file. */
export function auditPng(): Uint8Array {
  const { width, height } = AUDIT_PNG_SIZE;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    Buffer.from(data).copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = Math.round((x / width) * 255);
      raw[row + 2 + x * 3] = Math.round((y / height) * 255);
      raw[row + 3 + x * 3] = 160;
    }
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array()),
  ]));
}

type Rect = { x: number; y: number; w: number; h: number };
export type PictureCheck = { name: string; ok: boolean; detail: unknown };
const SIGNED = "**/storage/v1/object/sign/**";
const COMMAND = "**/functions/v1/command";
/** The failed picture's note and its Retry: where they are, how big the button is, and whether a pointer at its centre reaches it. */
const FAILED_NOTE = () => {
  const link = document.querySelector<HTMLElement>(".dashboard__message .hm-extras__image");
  const note = link?.parentElement?.querySelector<HTMLElement>(".hm-extras__image-failed");
  const button = note?.querySelector("button");
  const frame = link?.querySelector(".hm-extras__image-frame")?.getBoundingClientRect();
  if (!note || !button || !frame || !note.checkVisibility()) return null;
  const n = note.getBoundingClientRect(), b = button.getBoundingClientRect();
  return {
    text: note.textContent, name: button.getAttribute("aria-label"), inLink: !!button.closest("a"),
    button: { w: b.width, h: b.height },
    overFrame: Math.max(Math.abs(n.left - frame.left), Math.abs(n.top - frame.top), Math.abs(n.width - frame.width), Math.abs(n.height - frame.height)) <= 1,
    reached: document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === button,
    centre: { x: b.left + b.width / 2, y: b.top + b.height / 2 },
  };
};
/** The open picture viewer: its picture and stage, its three controls, and where focus is. Null when none is open. */
const VIEWER = () => {
  const dialog = document.querySelector<HTMLDialogElement>("dialog[data-image-viewer]");
  if (!dialog || !dialog.open) return null;
  const image = dialog.querySelector("img")!, stage = dialog.querySelector("[data-viewer-stage]")!;
  const box = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const active = document.activeElement as HTMLElement | null;
  return {
    state: dialog.dataset.state ?? null,
    loaded: image.complete && image.naturalWidth > 0,
    painted: getComputedStyle(image).visibility === "visible",
    natural: { w: image.naturalWidth, h: image.naturalHeight },
    image: box(image), stage: box(stage),
    zoomed: dialog.hasAttribute("data-zoomed"),
    pressed: dialog.querySelector("[data-viewer-zoom]")?.getAttribute("aria-pressed") ?? null,
    note: dialog.querySelector<HTMLElement>(".cs-viewer__note")?.checkVisibility() ? dialog.querySelector(".cs-viewer__note")!.textContent : null,
    controls: ["zoom", "download", "close"].map(key => {
      const button = dialog.querySelector(`[data-viewer-${key}]`);
      const r = button?.getBoundingClientRect();
      return !button || !r ? { key, ok: false } : {
        key, w: r.width, h: r.height,
        ok: r.width >= 44 && r.height >= 44 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
          && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("button") === button,
      };
    }),
    focus: !active ? "body" : active.dataset.viewerClose !== undefined ? "close" : active === dialog ? "viewer" : dialog.contains(active) ? "inside" : "outside",
  };
};
type Viewer = NonNullable<ReturnType<typeof VIEWER>>;
/** The whole picture is inside the stage, centred, at no more than its own size. */
const fitted = (v: Viewer): boolean => !v.zoomed && v.image.w <= v.natural.w + 0.5
  && v.image.x >= v.stage.x - 0.5 && v.image.y >= v.stage.y - 0.5 && v.image.x + v.image.w <= v.stage.x + v.stage.w + 0.5 && v.image.y + v.image.h <= v.stage.y + v.stage.h + 0.5
  && Math.abs(v.image.x + v.image.w / 2 - v.stage.x - v.stage.w / 2) <= 1 && Math.abs(v.image.y + v.image.h / 2 - v.stage.y - v.stage.h / 2) <= 1;
/** On each axis a picture larger than the stage shows no gap, and a smaller one is centred. */
const overStage = (v: Viewer): boolean => ([["x", "w"], ["y", "h"]] as const).every(([at, size]) =>
  v.image[size] > v.stage[size] + 0.5
    ? v.image[at] <= v.stage[at] + 0.5 && v.image[at] + v.image[size] >= v.stage[at] + v.stage[size] - 0.5
    : Math.abs(v.image[at] + v.image[size] / 2 - v.stage[at] - v.stage[size] / 2) <= 1);
const VIEWER_CHUNK = (url: URL) => /\/image-viewer[^/]*\.(?:js|ts)(?:$|\?)/u.test(url.pathname + url.search);

/** Where keyboard focus is, relative to the seeded picture: on its link, on its Retry, on the page body, or elsewhere. */
const FOCUS = () => {
  const link = document.querySelector<HTMLElement>(".dashboard__message .hm-extras__image");
  const active = document.activeElement;
  if (active === link) return "picture";
  if (active && active === link?.parentElement?.querySelector(".hm-extras__image-failed button")) return "retry";
  return active === document.body || !active ? "body" : active.tagName.toLowerCase();
};
const near = (a: Rect | null, b: Rect | null) => !!a && !!b && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h)) <= 0.5;

/** The seeded picture card's frame, image state and its message's other attachments. */
const PICTURE = () => {
  const link = document.querySelector<HTMLAnchorElement>(".dashboard__message .hm-extras__image");
  if (!link) return null;
  link.scrollIntoView({ block: "center" });
  const frame = link.querySelector(".hm-extras__image-frame");
  const image = link.querySelector("img");
  const r = frame?.getBoundingClientRect();
  const message = link.closest(".dashboard__message");
  return {
    frame: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
    signed: !!image?.getAttribute("src"),
    loaded: !!image && image.complete && image.naturalWidth > 0,
    painted: !!image && getComputedStyle(image).visibility === "visible",
    natural: image ? { w: image.naturalWidth, h: image.naturalHeight } : null,
    state: link.dataset.previewState ?? null,
    fileId: link.dataset.streamImage ?? null,
    pictures: message?.querySelectorAll(".hm-extras__image").length ?? 0,
    files: message?.querySelector(".hm-extras__files")?.querySelectorAll("a").length ?? 0,
  };
};
type Picture = NonNullable<ReturnType<typeof PICTURE>>;

/** `open(setup)` creates a page, runs `setup` on it (the storage routes) BEFORE any navigation, then opens the screen. */
export async function runPictureChecks(
  open: (setup: (page: any) => Promise<void>) => Promise<any>,
  shot: (page: any, label: string) => Promise<void>,
  options: { click: boolean },
): Promise<{ checks: PictureCheck[]; error: string | null }> {
  const checks: PictureCheck[] = [];
  const check = (name: string, ok: boolean, detail: unknown) => { checks.push({ name, ok, detail }); };
  const until = async (page: any, test: (p: Picture) => boolean, timeout = 15_000): Promise<Picture | null> => {
    const started = Date.now();
    let last: Picture | null = null;
    while (Date.now() - started < timeout) {
      last = await page.evaluate(PICTURE);
      if (last && test(last)) return last;
      await page.waitForTimeout(100);
    }
    return last;
  };
  try {
    // 0. Held signing: the picture has asked for its link and has none yet. The frame is already at its final size and nothing
    // of the picture is painted. The state is read and pictured from inside the request handler, while the request is in
    // flight, and the request then goes through: holding it until after the screen opened would never work, because
    // opening a screen waits for every request to finish and the app gives up on one after 30 seconds.
    const signing: { seen: boolean; picture: Picture | null } = { seen: false, picture: null };
    const unsignedPage = await open(async (p: any) => {
      await p.route(COMMAND, async (route: any) => {
        if (!signing.seen && (route.request().postData() ?? "").includes("file_download_url")) {
          signing.seen = true;
          for (const started = Date.now(); Date.now() - started < 5_000;) {
            signing.picture = await p.evaluate(PICTURE).catch(() => null);
            if (signing.picture?.state === "loading") break;
            await p.waitForTimeout(100);
          }
          await shot(p, "picture-signing").catch(() => {});
        }
        await route.continue();
      });
    });
    const unsigned = signing.picture;
    check("a picture with no link yet waits in its frame and is not painted", signing.seen && !!unsigned && !unsigned.signed && unsigned.state === "loading" && !unsigned.painted,
      { seen: signing.seen, unsigned });
    const signedLater = await until(unsignedPage, p => p.loaded);
    check("it appears in the same frame once its link is signed", !!signedLater?.loaded && signedLater.painted && signedLater.state === null && near(unsigned?.frame ?? null, signedLater.frame), { unsigned: unsigned?.frame, loaded: signedLater });
    await unsignedPage.close();

    // 1. Held storage: the frame is laid out at its final size before any byte arrives, and loading keeps it.
    let release: () => void = () => {};
    const held = new Promise<void>(done => { release = done; });
    const page = await open(async (p: any) => {
      await p.route(SIGNED, async (route: any) => {
        if (route.request().resourceType() === "image") await held;
        await route.continue();
      });
    });
    const before = await until(page, p => p.signed);
    check("picture is signed and waiting", !!before?.signed && !before.loaded, before);
    check("a picture still arriving is not painted", before?.state === "loading" && !before.painted, before);
    check("one picture and one file card on the mixed message", before?.pictures === 1 && before.files === 1, before);
    const frame = before?.frame ?? null;
    check("frame is reserved at 16:10 before the picture loads", !!frame && frame.w > 0 && Math.abs(frame.h - frame.w * 10 / 16) <= 1, frame);
    await shot(page, "picture-loading");
    release();
    const after = await until(page, p => p.loaded);
    check("picture loads at its real size", after?.natural?.w === AUDIT_PNG_SIZE.width && after.natural.h === AUDIT_PNG_SIZE.height, after);
    check("loading does not move or resize the frame", near(frame, after?.frame ?? null), { before: frame, after: after?.frame });
    check("a loaded picture is painted and carries no state", !!after?.painted && after.state === null, after);
    await shot(page, "picture-loaded");
    // 2. A press on the picture opens it in the viewer. Nothing navigates to the file and nothing downloads.
    const viewer = async (target: any, test: (v: Viewer | null) => boolean, timeout = 10_000): Promise<Viewer | null> => {
      const started = Date.now();
      let last: Viewer | null = null;
      while (Date.now() - started < timeout) {
        last = await target.evaluate(VIEWER);
        if (test(last)) return last;
        await target.waitForTimeout(100);
      }
      return last;
    };
    const signedFile = (request: any) => request.isNavigationRequest() && /\/storage\/v1\/object\/sign\//u.test(request.url());
    if (after?.frame) {
      let navigated = false;
      const watch = (request: any) => { if (signedFile(request)) navigated = true; };
      page.on("request", watch);
      const press = async (x: number, y: number) => { if (options.click) await page.mouse.click(x, y); else await page.touchscreen.tap(x, y); };
      const cx = after.frame.x + after.frame.w / 2, cy = after.frame.y + after.frame.h / 2;
      await press(cx, cy);
      const opened = await viewer(page, v => !!v && v.loaded && v.state === "");
      check("a press on the picture opens it in the viewer, whole and fitted", !!opened && opened.painted && fitted(opened)
        && opened.natural.w === AUDIT_PNG_SIZE.width && opened.natural.h === AUDIT_PNG_SIZE.height, opened);
      check("Zoom, Download and Close are 44px, on screen and reachable", !!opened && opened.controls.every(c => c.ok), opened?.controls ?? null);
      check("the viewer opens with focus on Close", opened?.focus === "close", opened?.focus ?? null);
      await shot(page, "viewer-fitted");
      // A press on the picture itself does nothing: the viewer stays open and fitted.
      const mid = opened ? { x: opened.stage.x + opened.stage.w / 2, y: opened.stage.y + opened.stage.h / 2 } : { x: cx, y: cy };
      await press(mid.x, mid.y);
      await page.waitForTimeout(450);
      const pressed = await page.evaluate(VIEWER);
      check("a press on the picture never closes the viewer or starts a download", !!pressed && fitted(pressed) && !navigated, { pressed, navigated });
      // Zoom, then a long drag: the picture moves and cannot leave the stage. Letting go leaves the viewer open.
      await page.locator("[data-viewer-zoom]").click();
      await page.waitForTimeout(350);
      const close = await page.evaluate(VIEWER);
      check("Zoom shows the picture close up", !!close && !!opened && close.zoomed && close.pressed === "true" && close.image.w >= opened.image.w * 1.9 && overStage(close), close);
      if (options.click) {
        await page.mouse.move(mid.x, mid.y); await page.mouse.down();
        await page.mouse.move(mid.x + 700, mid.y + 700, { steps: 6 }); await page.mouse.up();
      } else {
        const cdp = await page.context().newCDPSession(page);
        try {
          const touch = (type: string, points: { x: number; y: number }[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ ...p, id })) });
          await touch("touchStart", [mid]);
          for (let step = 1; step <= 6; step++) await touch("touchMove", [{ x: mid.x, y: mid.y + step * 60 }]);
          await touch("touchEnd", []);
        } finally { await cdp.detach().catch(() => {}); }
      }
      await page.waitForTimeout(250);
      const panned = await page.evaluate(VIEWER);
      check("a drag on the zoomed picture stops at its edge and leaves the viewer open", !!panned && !!close && panned.zoomed && overStage(panned)
        && Math.abs(panned.image.w - close.image.w) <= 1, { close: close?.image, panned: panned?.image, stage: panned?.stage });
      await shot(page, "viewer-zoomed");
      // Keyboard: 0 fits again; Escape closes and focus returns to the picture; Enter on it opens the viewer again; Close returns focus too.
      await page.keyboard.press("0");
      await page.waitForTimeout(350);
      const refit = await page.evaluate(VIEWER);
      check("0 fits the picture again", !!refit && fitted(refit) && refit.pressed === "false", refit);
      await page.keyboard.press("Escape");
      const shut = await viewer(page, v => v === null);
      check("Escape closes the viewer and focus returns to the picture", shut === null && await page.evaluate(FOCUS) === "picture", { open: shut !== null, focus: await page.evaluate(FOCUS) });
      await page.keyboard.press("Enter");
      const again = await viewer(page, v => !!v && v.loaded && v.state === "");
      check("Enter on the picture opens the viewer, fitted", !!again && fitted(again), again);
      if (!options.click && again) {
        // A phone: two fingers pinch it open, and lifting them leaves the viewer open; then one finger from fitted size pulls it shut.
        const cdp = await page.context().newCDPSession(page);
        try {
          const touch = (type: string, points: { x: number; y: number }[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ ...p, id })) });
          const at = { x: again.stage.x + again.stage.w / 2, y: again.stage.y + again.stage.h / 2 };
          await touch("touchStart", [{ x: at.x - 30, y: at.y }, { x: at.x + 30, y: at.y }]);
          for (let step = 1; step <= 5; step++) await touch("touchMove", [{ x: at.x - 30 - step * 14, y: at.y }, { x: at.x + 30 + step * 14, y: at.y }]);
          await touch("touchEnd", []);
          await page.waitForTimeout(250);
          const pinched = await page.evaluate(VIEWER);
          check("a pinch zooms the picture, and lifting the fingers leaves the viewer open", !!pinched && pinched.zoomed && pinched.image.w >= again.image.w * 1.5 && overStage(pinched), pinched);
          // One finger pulled down on a ZOOMED picture pans it; it does not close the viewer.
          await touch("touchStart", [at]);
          for (let step = 1; step <= 5; step++) await touch("touchMove", [{ x: at.x, y: at.y + step * 50 }]);
          await touch("touchEnd", []);
          await page.waitForTimeout(250);
          const held = await page.evaluate(VIEWER);
          check("a swipe down on a zoomed picture does not close the viewer", !!held && held.zoomed, held);
          await page.keyboard.press("0");
          await page.waitForTimeout(350);
          await touch("touchStart", [at]);
          for (let step = 1; step <= 5; step++) await touch("touchMove", [{ x: at.x, y: at.y + step * 50 }]);
          await touch("touchEnd", []);
          const swiped = await viewer(page, v => v === null, 5_000);
          check("a one-finger swipe down from fitted size closes the viewer, with focus back on the picture", swiped === null && await page.evaluate(FOCUS) === "picture", { open: swiped !== null, focus: await page.evaluate(FOCUS) });
        } finally { await cdp.detach().catch(() => {}); }
      } else if (again) {
        // A mouse: a double click zooms about the pointer and a second one fits again; Close returns focus to the picture.
        const at = { x: again.image.x + again.image.w / 2, y: again.image.y + again.image.h / 2 };
        await page.mouse.dblclick(at.x, at.y);
        await page.waitForTimeout(350);
        const doubled = await page.evaluate(VIEWER);
        await page.mouse.dblclick(at.x, at.y);
        await page.waitForTimeout(350);
        const undone = await page.evaluate(VIEWER);
        check("a double click zooms in, and another fits again", !!doubled && doubled.zoomed && !!undone && fitted(undone), { doubled: doubled?.image, undone: undone?.image });
        await page.locator("[data-viewer-close]").click();
        const closed = await viewer(page, v => v === null);
        check("Close closes the viewer and focus returns to the picture", closed === null && await page.evaluate(FOCUS) === "picture", { open: closed !== null, focus: await page.evaluate(FOCUS) });
      }
      check("nothing navigated to the file while the viewer was used", !navigated, navigated);
      page.off("request", watch);
      // Download is the viewer's own button, and it starts the picture's own signed file. Activate the picture link
      // directly so a background feed rebuild frame cannot send bare Enter to <body>.
      await page.locator(".dashboard__message .hm-extras__image").first().press("Enter");
      const forDownload = await viewer(page, v => !!v && v.loaded && v.state === "");
      let commandStatus: number | null = null;
      const onCommandResponse = (response: any) => {
        if (String(response.url()).includes("/functions/v1/command") && (response.request().postData() ?? "").includes("file_download_url")) {
          commandStatus = response.status();
        }
      };
      let path: string | null = null;
      if (forDownload?.loaded && forDownload.state === "") {
        page.on("response", onCommandResponse);
        try {
          const navigation = page.waitForRequest(signedFile, { timeout: 15_000 }).then((request: any) => new URL(request.url()).pathname, () => null);
          await page.locator("[data-viewer-download]").click();
          path = await navigation;
        } finally { page.off("response", onCommandResponse); }
      }
      check("Download in the viewer starts the picture's own signed file", typeof path === "string" && !!after.fileId && path.includes(`/${after.fileId}/`),
        { path, fileId: after.fileId, ...(typeof path === "string" ? {} : { opened: !!forDownload, loaded: forDownload?.loaded ?? null, state: forDownload?.state ?? null, commandStatus, focus: await page.evaluate(FOCUS) }) });
    }
    await page.close();

    // 2a. The viewer's code cannot be fetched (a dropped connection, or a tab left open across a release). Nothing downloads and
    // nothing navigates: the reader stays at the picture, which says so and offers Retry. With the code back, Retry opens the viewer.
    let chunkDown = true, chunkAsked = 0, strayed = false;
    const stale = await open(async (p: any) => {
      await p.route(VIEWER_CHUNK, async (route: any) => {
        chunkAsked++;
        if (chunkDown) await route.fulfill({ status: 404, body: "not found" }); else await route.continue();
      });
    });
    stale.on("request", (request: any) => { if (signedFile(request)) strayed = true; });
    stale.on("download", () => { strayed = true; });
    const OPEN_FAILED = () => {
      const link = document.querySelector<HTMLElement>(".dashboard__message .hm-extras__image");
      const note = link?.parentElement?.querySelector<HTMLElement>("[data-picture-open-failed]");
      const button = note?.querySelector("button");
      const frame = link?.querySelector(".hm-extras__image-frame")?.getBoundingClientRect();
      if (!link || !note || !button || !frame) return null;
      const n = note.getBoundingClientRect(), b = button.getBoundingClientRect();
      return {
        text: note.textContent, role: note.getAttribute("role"), button: { w: b.width, h: b.height },
        overFrame: Math.max(Math.abs(n.left - frame.left), Math.abs(n.top - frame.top), Math.abs(n.width - frame.width), Math.abs(n.height - frame.height)) <= 1,
        reached: document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === button,
        focus: document.activeElement === link ? "picture" : document.activeElement === button ? "retry" : document.activeElement === document.body ? "body" : "elsewhere",
        url: location.pathname + location.search,
      };
    };
    const loadedStale = await until(stale, p => p.loaded);
    const staleAt = await stale.evaluate(() => location.pathname + location.search);
    await stale.evaluate(() => document.querySelector<HTMLElement>(".dashboard__message .hm-extras__image")?.focus());
    await stale.keyboard.press("Enter");
    let refused: Awaited<ReturnType<typeof OPEN_FAILED>> = null;
    for (const started = Date.now(); Date.now() - started < 10_000 && !refused;) { refused = await stale.evaluate(OPEN_FAILED); if (!refused) await stale.waitForTimeout(100); }
    await stale.waitForTimeout(500);
    check("when the viewer cannot be fetched, nothing downloads or navigates and no viewer opens", !!loadedStale?.loaded && chunkAsked >= 1 && !strayed && !!refused && refused.url === staleAt
      && await stale.evaluate(VIEWER) === null, { loaded: loadedStale?.loaded, chunkAsked, strayed, refused, staleAt });
    check("the picture says it could not be opened and offers Retry, with focus still on the picture", !!refused && /^Couldn't open picture\s*Retry$/u.test(refused.text ?? "") && refused.role === "alert"
      && refused.overFrame && refused.reached && refused.button.w >= 44 && refused.button.h >= 44 && refused.focus === "picture", refused);
    await shot(stale, "viewer-unavailable");
    chunkDown = false;
    await stale.keyboard.press("Tab");
    const onRetryOpen = (await stale.evaluate(OPEN_FAILED))?.focus ?? null;
    await stale.keyboard.press("Enter");
    const recovered2 = await viewer(stale, v => !!v && v.loaded && v.state === "");
    check("Tab reaches that Retry, and with the viewer's code back it opens the viewer", onRetryOpen === "retry" && !!recovered2 && fitted(recovered2) && await stale.evaluate(OPEN_FAILED) === null && !strayed,
      { onRetryOpen, recovered: recovered2, strayed });
    await stale.close();

    // 2b. A link that fails once (an expired one does): a new link is signed and the picture loads. No failure is shown on the way.
    let imageReads = 0, sawFailure = false, paintedUnloaded = false;
    const flaky = await open(async (p: any) => {
      await p.route(SIGNED, async (route: any) => {
        if (route.request().resourceType() !== "image") await route.continue();
        else if (imageReads++ === 0) await route.fulfill({ status: 403, body: "expired" });
        else await route.continue();
      });
    });
    const recovered = await until(flaky, p => {
      if (p.state === "unavailable") sawFailure = true;
      if (!p.loaded && p.painted) paintedUnloaded = true;
      return p.loaded;
    });
    check("a picture whose first link fails loads from a new one, with no failure shown", !!recovered?.loaded && recovered.painted && imageReads >= 2 && !sawFailure && !paintedUnloaded,
      { recovered, imageReads, sawFailure, paintedUnloaded });
    await flaky.close();

        // 3. Failed storage: after one retry the frame says so and keeps its size; then the composer's staged previews.
    let failedReads = 0, storageDown = true;
    const failing = await open(async (p: any) => {
      await p.route(SIGNED, async (route: any) => {
        if (route.request().resourceType() === "image" && storageDown) { failedReads++; await route.fulfill({ status: 404, body: "not found" }); }
        else await route.continue();
      });
    });
    const failed = await until(failing, p => p.state === "unavailable");
    check("a picture that fails shows the unavailable state", failed?.state === "unavailable" && !failed.loaded, failed);
    check("failing does not move or resize the frame", near(frame, failed?.frame ?? null), { before: frame, failed: failed?.frame });
    check("a failed picture is not painted", !!failed && !failed.painted, failed);
    const note = await failing.evaluate(FAILED_NOTE);
    check("a failed picture says so and offers Retry over its frame", !!note && /^Couldn't load image\s*Retry$/u.test(note.text ?? "") && note.overFrame && !note.inLink && note.reached, note);
    check("Retry is a 44px target", !!note && note.button.w >= 44 && note.button.h >= 44, note?.button ?? null);
    await shot(failing, "picture-unavailable");
    // The viewer on a picture that cannot load: it says so, offers Retry, and keeps Download and Close.
    await failing.evaluate(() => document.querySelector<HTMLElement>(".dashboard__message .hm-extras__image")?.focus());
    await failing.keyboard.press("Enter");
    const broken = await viewer(failing, v => !!v && v.state === "failed");
    check("the viewer says a picture could not load and offers Retry, with nothing painted", !!broken && !broken.painted && /^Couldn't load image\s*Retry$/u.test(broken.note ?? "") && broken.controls.every(c => c.ok), broken);
    await shot(failing, "viewer-failed");
    await failing.keyboard.press("Escape");
    const brokenShut = await viewer(failing, v => v === null);
    check("Escape closes that viewer too, with focus back on the picture", brokenShut === null && await failing.evaluate(FOCUS) === "picture", await failing.evaluate(FOCUS));
    // Retry from the keyboard while storage still fails: focus goes to the picture, never the page, and stays there
    // when the failure comes back. Tab from the picture then reaches Retry again.
    const readsBefore = failedReads;
    await failing.evaluate(() => document.querySelector<HTMLElement>(".dashboard__message .hm-extras__picture .hm-extras__image-failed button")?.focus());
    const onRetry = await failing.evaluate(FOCUS);
    await failing.keyboard.press("Enter");
    const afterEnter = await failing.evaluate(FOCUS);
    const started = Date.now();
    while (Date.now() - started < 15_000 && failedReads < readsBefore + 2) await failing.waitForTimeout(100);
    const failedAgain = await until(failing, p => p.state === "unavailable");
    const afterFailure = await failing.evaluate(FOCUS);
    check("Enter on Retry moves focus to the picture, and a failed retry leaves it there",
      onRetry === "retry" && afterEnter === "picture" && failedReads >= readsBefore + 2 && failedAgain?.state === "unavailable" && afterFailure === "picture",
      { onRetry, afterEnter, afterFailure, reads: failedReads - readsBefore, state: failedAgain?.state });
    await failing.keyboard.press("Tab");
    const tabbed = await failing.evaluate(FOCUS);
    check("Tab from the picture reaches Retry", tabbed === "retry", tabbed);
    // Storage answers again: Enter on Retry loads the picture in the same frame, with focus on the picture.
    storageDown = false;
    await failing.keyboard.press("Enter");
    const retried = await until(failing, p => p.loaded);
    const afterLoad = await failing.evaluate(FOCUS);
    check("Retry loads the picture in the same frame", !!retried?.loaded && retried.painted && retried.state === null && near(frame, retried.frame), retried);
    check("a successful retry leaves focus on the picture", afterLoad === "picture", afterLoad);
    check("the note is gone once the picture has loaded", (await failing.evaluate(FAILED_NOTE)) === null, null);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await failing.setInputFiles("[data-composer-file-input]", [
      { name: "label.png", mimeType: "image/png", buffer: Buffer.from(auditPng()) },
      { name: "logo.svg", mimeType: "image/svg+xml", buffer: svg },
    ]);
    await failing.waitForSelector("[data-staged-attachment]", { state: "visible", timeout: 10_000 });
    const staged: { name?: string; image: { w: number; h: number } | null }[] = await failing.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[data-staged-attachment]")).map(chip => {
      const image = chip.querySelector("img")?.getBoundingClientRect();
      return { name: chip.dataset.stagedAttachment, image: image ? { w: image.width, h: image.height } : null };
    }));
    const png = staged.find(s => s.name === "label.png"), vector = staged.find(s => s.name === "logo.svg");
    check("a staged PNG shows a 64x48 preview", !!png?.image && Math.abs(png.image.w - 64) <= 0.5 && Math.abs(png.image.h - 48) <= 0.5, staged);
    check("a staged SVG is never drawn as a picture", !!vector && vector.image === null, staged);
    await shot(failing, "picture-staged");
    await failing.close();
    return { checks, error: null };
  } catch (error) {
    return { checks, error: String(error instanceof Error ? error.message : error).split("\n")[0]!.slice(0, 300) };
  }
}

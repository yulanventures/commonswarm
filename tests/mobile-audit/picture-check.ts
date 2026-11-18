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
    // 0. Held signing: the picture has no link yet. The frame is already at its final size and nothing of the picture is painted.
    let sign: () => void = () => {};
    const signHeld = new Promise<void>(done => { sign = done; });
    const unsignedPage = await open(async (p: any) => {
      await p.route(COMMAND, async (route: any) => {
        if ((route.request().postData() ?? "").includes("file_download_url")) await signHeld;
        await route.continue();
      });
    });
    const unsigned = await until(unsignedPage, p => p.state === "loading");
    check("a picture with no link yet waits in its frame and is not painted", !!unsigned && !unsigned.signed && unsigned.state === "loading" && !unsigned.painted, unsigned);
    await shot(unsignedPage, "picture-signing");
    sign();
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
    // 2. A native click on the picture opens its own signed file.
    if (options.click && after?.frame) {
      const navigation = page.waitForRequest((request: any) => request.isNavigationRequest() && /\/storage\/v1\/object\/sign\//u.test(request.url()), { timeout: 15_000 })
        .then((request: any) => new URL(request.url()).pathname, () => null);
      await page.mouse.click(after.frame.x + after.frame.w / 2, after.frame.y + after.frame.h / 2);
      const path = await navigation;
      check("clicking the picture opens its own signed file", typeof path === "string" && !!after.fileId && path.includes(`/${after.fileId}/`), { path, fileId: after.fileId });
    }
    await page.close();

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
    const failing = await open(async (p: any) => {
      await p.route(SIGNED, async (route: any) => {
        if (route.request().resourceType() === "image") await route.fulfill({ status: 404, body: "not found" });
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
    // Storage answers again: Retry signs a new link and the picture loads in the same frame.
    await failing.unroute(SIGNED);
    if (note) await failing.mouse.click(note.centre.x, note.centre.y);
    const retried = await until(failing, p => p.loaded);
    check("Retry loads the picture in the same frame", !!retried?.loaded && retried.painted && retried.state === null && near(frame, retried.frame), retried);
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

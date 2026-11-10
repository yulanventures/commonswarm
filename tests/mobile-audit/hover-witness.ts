/**
 * Hover-stability witness (owner request, Nov 10): hovering or focusing a row must never move or resize
 * anything. For each declared row it parks the pointer, records rest geometry, hovers the row with a native
 * mouse move (then, separately, focuses its first control), and compares again, early and after transitions.
 *
 * What is compared: the hovered row, every element inside it that was rendered at rest, every line fragment
 * of its text, and every other row of the same list. An element that only appears on hover is not compared (an
 * absolutely placed toolbar may appear); anything it pushes is. Moving or resizing by more than 0.5px is a
 * shift. Unlike the other witnesses, a shift fails the audit: the owner asked for a guard.
 *
 * Page functions are self-contained: they run in the page through evaluate().
 */
export type HoverSpec = {
  name: string;
  /** Rows of one list; the first `max` visible ones are measured, `prefer` matches first. */
  rows: string;
  prefer?: string;
  max?: number;
  /** Each selector must match a row that was actually measured (stable or shifted) in every mode the spec runs,
   *  or the spec is an error: the owner's cases must really be measured, not just present. Required rows are measured first. */
  require?: string[];
  /** Also focus each row's first control (`:focus-within` and focus styles). */
  focus?: boolean;
  /** In focus mode, the control to focus inside the row instead of its first one. */
  focusTarget?: string;
};

export const HOVER_TOLERANCE_PX = 0.5;

export type HoverPage = {
  evaluate: <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>;
  mouse: { move: (x: number, y: number, options?: { steps?: number }) => Promise<void> };
  locator: (selector: string) => { first(): { scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void> } };
};

/** Mark the rows to measure; return what each one is, so coverage of the owner's cases is visible. */
const MARK_ROWS = (spec: { rows: string; prefer?: string; first: string[]; max: number }) => {
  for (const old of document.querySelectorAll("[data-audit-hover-row]")) old.removeAttribute("data-audit-hover-row");
  const shown = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden" || (e as HTMLElement).hidden) return false;
    }
    return true;
  };
  const all = Array.from(document.querySelectorAll(spec.rows)).filter(shown);
  const preferred = spec.prefer ? all.filter(el => el.matches(spec.prefer!)) : [];
  const required = all.filter(el => spec.first.some(selector => el.matches(selector)));
  // After required and preferred rows: rows already in view, then the newest. Scrolling a feed toward its top makes
  // the app load older messages and rebuild the list mid-measurement.
  const inView = (el: Element) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  const others = [...all.filter(inView).reverse(), ...all.filter(el => !inView(el)).reverse()];
  const ordered = [...new Set([...required, ...preferred, ...others])].slice(0, Math.max(spec.max, required.length));
  return {
    found: all.length,
    rows: ordered.map((el, index) => {
      el.setAttribute("data-audit-hover-row", String(index));
      const target = el.querySelector("[data-target-kind]");
      return {
        index,
        key: el.getAttribute("data-signal-id"),
        preferred: preferred.includes(el),
        targetKind: target?.getAttribute("data-target-kind") ?? null,
        authorKind: el.querySelector("[data-author-kind]")?.getAttribute("data-author-kind")
          ?? (el.querySelector(".dashboard__message-identity-badge")?.textContent?.trim().toLowerCase() || null),
      };
    }),
  };
};

/** Find the marked row again after the app rebuilt its list, by its stable key; false when it is gone. */
const REMARK = (arg: { index: number; key: string | null; rows: string }) => {
  if (document.querySelector(`[data-audit-hover-row="${arg.index}"]`)) return true;
  if (!arg.key) return false;
  const again = Array.from(document.querySelectorAll(arg.rows)).find(el => el.getAttribute("data-signal-id") === arg.key);
  if (!again) return false;
  again.setAttribute("data-audit-hover-row", String(arg.index));
  return true;
};

/** The coverage selectors the marked row matches. */
const ROW_MATCHES = (arg: { index: number; selectors: string[] }) => {
  const row = document.querySelector(`[data-audit-hover-row="${arg.index}"]`);
  return row ? arg.selectors.filter(selector => row.matches(selector)) : [];
};

/**
 * phase "rest": wait for transitions, snapshot twice a frame apart (a difference is drift, not hover), store.
 * phase "early" / "late": compare with the stored rest snapshot.
 */
type ProbeError = { error: string };
type ProbeRest = { tracked: number; measured: number; drift: number };
type Shift = { who: string; label: string; dx: number; dy: number; dw: number; dh: number; gone: boolean; lines?: [number, number] };
type ProbeCompared = { shifted: number; shifts: Shift[]; hoverMatched: boolean; focusWithin: boolean; focusVisible: boolean;
  /** Lifecycle facts, kept whatever the outcome: boxes found again after the app rebuilt them, and how far the
   *  row's lists scrolled. Neither is discounted: positions are compared in scroll-content coordinates. */
  rebuilt: number; scrolled: { x: number; y: number } };
/**
 * phase "rest": settle the page's reads, wait for transitions, snapshot twice a frame apart (a difference is drift),
 * store. phase "early" / "late": compare with the stored rest snapshot.
 *
 * Identity is by key, not by node: each box is the row's data-signal-id plus its child path, so a row the app rebuilt
 * is found again and compared by geometry (a same-ID rebuild with identical layout is stable; a rebuild that moves
 * anything is a shift). Positions are viewport positions plus the scroll offsets of the row's scrolling ancestors:
 * the app scrolling its list is not a shift, and hover reflow absorbed by scroll anchoring still is.
 */
const PROBE = async (arg: { index: number; key?: string | null; rows: string; phase: "rest" | "early" | "late"; tolerance: number }): Promise<ProbeError | ProbeRest | ProbeCompared> => {
  type Rect = { x: number; y: number; w: number; h: number };
  type Tracked = { node: Element | Text; who: "row" | "inside" | "text" | "other-row"; label: string; rowKey: string | null; path: number[] };
  const w = globalThis as unknown as { __auditHoverRest?: { tracked: Tracked[]; rects: Rect[][]; scroll: { x: number; y: number } };
    __auditPendingFetches?: number; __auditLastFetchDoneAt?: number };
  const frame = () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  // An element is one box; a text node is every line fragment it lays out, so a re-wrap that keeps every element box
  // (same width, same line count) still moves a fragment.
  const rectsOf = (node: Element | Text): Rect[] => {
    let list: DOMRect[];
    if (node instanceof Text) { const range = document.createRange(); range.selectNodeContents(node); list = Array.from(range.getClientRects()); }
    else list = [node.getBoundingClientRect()];
    return list.filter(r => r.width > 0 || r.height > 0).map(r => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
  };
  const describe = (el: Element) => {
    const classes = Array.from(el.classList).slice(0, 2).map(c => `.${c}`).join("");
    const data = Array.from(el.attributes).find(a => a.name.startsWith("data-") && a.name !== "data-audit-hover-row");
    return `${el.tagName.toLowerCase()}${classes}${data ? `[${data.name}]` : ""}`;
  };
  const pathFrom = (root: Node, node: Node): number[] => {
    const path: number[] = [];
    for (let n: Node = node; n !== root && n.parentNode; n = n.parentNode) path.unshift(Array.prototype.indexOf.call(n.parentNode.childNodes, n));
    return path;
  };
  const rowByKey = (key: string) => Array.from(document.querySelectorAll(arg.rows)).find(el => el.getAttribute("data-signal-id") === key) ?? null;
  // The live node for a tracked box: itself while connected, else the same path in the row rebuilt under the same key.
  const resolve = (t: Tracked): { node: Element | Text | null; rebuilt: boolean } => {
    if (t.node.isConnected) return { node: t.node, rebuilt: false };
    if (!t.rowKey) return { node: null, rebuilt: false };
    let n: Node | null = rowByKey(t.rowKey);
    for (const i of t.path) n = n?.childNodes[i] ?? null;
    return n instanceof Element || n instanceof Text ? { node: n, rebuilt: true } : { node: null, rebuilt: false };
  };
  const scrollOf = (start: Element | null) => {
    let x = 0, y = 0;
    for (let e: Element | null = start; e; e = e.parentElement) {
      if (e === document.scrollingElement) continue; // The page scroll is added once, below.
      if (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth) { x += e.scrollLeft; y += e.scrollTop; }
    }
    const page = document.scrollingElement;
    if (page) { x += page.scrollLeft; y += page.scrollTop; }
    return { x, y };
  };
  const delta = (a: Rect[], b: Rect[]) => a.length !== b.length ? Infinity
    : Math.max(0, ...a.map((r, i) => Math.max(Math.abs(r.x - b[i]!.x), Math.abs(r.y - b[i]!.y), Math.abs(r.w - b[i]!.w), Math.abs(r.h - b[i]!.h))));
  if (arg.phase === "rest") {
    // Let the page's reads (and the re-renders they cause) finish: up to 5 s for none pending and 400 ms quiet.
    for (const started = performance.now(); performance.now() - started < 5_000;) {
      if ((w.__auditPendingFetches ?? 0) === 0 && performance.now() - (w.__auditLastFetchDoneAt ?? 0) >= 400) break;
      await new Promise(done => setTimeout(done, 50));
    }
    // Only now, with reads settled, find the row: by its marker, or by its key when the list was rebuilt meanwhile.
    let row = document.querySelector(`[data-audit-hover-row="${arg.index}"]`);
    if (!row && arg.key) {
      row = rowByKey(arg.key);
      row?.setAttribute("data-audit-hover-row", String(arg.index));
    }
    if (!row) return { error: "row gone" };
    const key = row.getAttribute("data-signal-id");
    const tracked: Tracked[] = [{ node: row, who: "row", label: describe(row), rowKey: key, path: [] }];
    for (const el of Array.from(row.querySelectorAll("*")).slice(0, 400)) tracked.push({ node: el, who: "inside", label: describe(el), rowKey: key, path: pathFrom(row, el) });
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    let texts = 0;
    for (let node = walker.nextNode(); node && texts < 120; node = walker.nextNode()) {
      if (!rectsOf(node as Text).length) continue; // Not laid out at rest (inside a hidden element).
      texts += 1;
      tracked.push({ node: node as Text, who: "text", label: `text in ${node.parentElement ? describe(node.parentElement) : "row"}`, rowKey: key, path: pathFrom(row, node) });
    }
    for (const other of Array.from(document.querySelectorAll(arg.rows)).slice(0, 80)) {
      if (other !== row && !row.contains(other) && !other.contains(row)) {
        tracked.push({ node: other, who: "other-row", label: describe(other), rowKey: other.getAttribute("data-signal-id"), path: [] });
      }
    }
    await new Promise(done => setTimeout(done, 300));
    await frame();
    const first = tracked.map(t => rectsOf(t.node));
    await frame();
    const second = tracked.map(t => rectsOf(t.node));
    const drift = first.filter((r, i) => r.length > 0 && delta(r, second[i]!) > arg.tolerance).length;
    w.__auditHoverRest = { tracked, rects: second, scroll: scrollOf(row.parentElement) };
    return { tracked: tracked.length, measured: second.filter(r => r.length > 0).length, drift };
  }
  const rest = w.__auditHoverRest;
  if (!rest) return { error: "no rest snapshot" };
  if (arg.phase === "early") await frame(); else { await new Promise(done => setTimeout(done, 400)); await frame(); }
  const liveRow = resolve(rest.tracked[0]!).node;
  const now = scrollOf(liveRow instanceof Element ? liveRow.parentElement : null);
  const scrolled = { x: now.x - rest.scroll.x, y: now.y - rest.scroll.y };
  const shifts: Shift[] = [];
  let rebuilt = 0;
  const round = (n: number) => Math.round(n * 100) / 100;
  // Scroll-content coordinates: add how far the lists scrolled since rest.
  const content = (r: Rect): Rect => ({ x: r.x + scrolled.x, y: r.y + scrolled.y, w: r.w, h: r.h });
  rest.tracked.forEach((t, i) => {
    const before = rest.rects[i]!;
    if (!before.length) return; // Not rendered at rest: something revealed on hover is not itself a shift.
    const live = resolve(t);
    if (live.rebuilt) rebuilt += 1;
    const after = live.node ? rectsOf(live.node).map(content) : [];
    if (delta(before, after) <= arg.tolerance) return;
    if (after.length === 0) { shifts.push({ who: t.who, label: t.label, dx: 0, dy: 0, dw: 0, dh: 0, gone: true }); return; }
    // Report the fragment that moved most (or the first, when the line count itself changed).
    const pairs = before.map((r, k) => [r, after[Math.min(k, after.length - 1)]!] as const);
    const [b, n] = pairs.reduce((worst, pair) => delta([pair[0]], [pair[1]]) > delta([worst[0]], [worst[1]]) ? pair : worst, pairs[0]!);
    shifts.push({ who: t.who, label: t.label, dx: round(n.x - b.x), dy: round(n.y - b.y), dw: round(n.w - b.w), dh: round(n.h - b.h), gone: false,
      ...(before.length !== after.length ? { lines: [before.length, after.length] as [number, number] } : {}) });
  });
  const row = liveRow instanceof Element ? liveRow : null;
  const active = document.activeElement;
  return {
    shifted: shifts.length,
    shifts: shifts.sort((a, b) => Number(b.gone) - Number(a.gone) || Math.max(Math.abs(b.dx), Math.abs(b.dy), Math.abs(b.dw), Math.abs(b.dh)) - Math.max(Math.abs(a.dx), Math.abs(a.dy), Math.abs(a.dw), Math.abs(a.dh))).slice(0, 6),
    hoverMatched: !!row?.matches(":hover"),
    focusWithin: !!row?.matches(":focus-within"),
    focusVisible: !!active && active !== document.body && active.matches(":focus-visible"),
    rebuilt,
    scrolled: { x: round(scrolled.x), y: round(scrolled.y) },
  };
};

/** A point inside the row that the row itself receives (not an overlay or a neighbour), in the viewport. */
const HOVER_POINT = (index: number) => {
  const row = document.querySelector(`[data-audit-hover-row="${index}"]`);
  if (!row) return null;
  const r = row.getBoundingClientRect();
  const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, innerHeight), left = Math.max(r.left, 0), right = Math.min(r.right, innerWidth);
  if (bottom - top < 1 || right - left < 1) return null;
  for (const [fx, fy] of [[0.5, 0.5], [0.75, 0.5], [0.5, 0.25], [0.9, 0.5], [0.25, 0.5], [0.5, 0.75]] as const) {
    const x = left + (right - left) * fx, y = top + (bottom - top) * fy;
    const hit = document.elementFromPoint(x, y);
    if (hit && row.contains(hit)) return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  }
  return null;
};

/** Focus the row's first visible control without scrolling; returns what was focused. */
const FOCUS_ROW = (arg: { index: number; target?: string }) => {
  const row = document.querySelector(`[data-audit-hover-row="${arg.index}"]`);
  if (!row) return null;
  const focusable = arg.target ? row.querySelector(arg.target) as HTMLElement | null ?? undefined : [row, ...Array.from(row.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])"))]
    .find(el => el.matches("a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])")
      && el.getBoundingClientRect().width > 0) as HTMLElement | undefined;
  if (!focusable) return null;
  focusable.focus({ preventScroll: true });
  return document.activeElement === focusable ? `${focusable.tagName.toLowerCase()}${focusable.className ? `.${String(focusable.className).split(" ")[0]}` : ""}` : null;
};
/**
 * A parking point whose hit target is outside every row of the list (and not a row itself), so rest is never taken
 * with a row already hovered. Viewport corners and edge midpoints first; null when no such point exists.
 */
const NEUTRAL_POINT = (rows: string) => {
  const listed = Array.from(document.querySelectorAll(rows));
  const w = innerWidth, h = innerHeight;
  const candidates = [[w - 2, h - 2], [w - 2, 1], [1, h - 2], [1, 1], [w / 2, h - 2], [w - 2, h / 2], [w / 2, 1], [1, h / 2]];
  for (const [x, y] of candidates) {
    const hit = document.elementFromPoint(x!, y!);
    if (hit && listed.some(row => row === hit || row.contains(hit))) continue;
    return { x: x!, y: y! };
  }
  return null;
};
/** How many rows of the list the browser currently reports as hovered. */
const HOVERED_ROWS = (rows: string) => Array.from(document.querySelectorAll(rows)).filter(row => row.matches(":hover")).length;
const BLUR = (_: null) => { (document.activeElement as HTMLElement | null)?.blur?.(); };
const HOVER_CAPABLE = (_: null) => matchMedia("(hover: hover)").matches;

type Compared = ProbeCompared;
const failed = (p: ProbeError | ProbeRest | ProbeCompared): p is ProbeError => "error" in p;
export type HoverRowResult = {
  index: number; key: string | null; preferred: boolean; targetKind: string | null; authorKind: string | null; mode: "hover" | "focus";
  /** Coverage selectors the live, measured row matched. */
  matches?: string[];
  outcome: "stable" | "shifted" | "unstable" | "skipped" | "error"; reason: string | null;
  point?: { x: number; y: number } | null; focused?: string | null;
  early?: Compared; late?: Compared; restored?: Compared; restoredShifts?: number;
};

export async function runHoverWitness(page: HoverPage, spec: HoverSpec, shot?: (label: string) => Promise<void>) {
  const modes: ("hover" | "focus")[] = spec.focus ? ["hover", "focus"] : ["hover"];
  const required = spec.require ?? [];
  const coverage = required.flatMap(selector => modes.map(mode => ({ selector, mode, measured: false })));
  const result: { name: string; hoverCapable: boolean | null; found: number; rows: HoverRowResult[]; coverage: typeof coverage;
    outcome: "stable" | "shifted" | "error"; reason: string | null } =
    { name: spec.name, hoverCapable: null, found: 0, rows: [], coverage, outcome: "stable", reason: null };
  const tolerance = HOVER_TOLERANCE_PX;
  const shotTaken = new Set<string>();
  try {
    result.hoverCapable = await page.evaluate(HOVER_CAPABLE, null);
    const marked = await page.evaluate(MARK_ROWS, { rows: spec.rows, prefer: spec.prefer, first: required, max: spec.max ?? 8 });
    result.found = marked.found;
    for (const row of marked.rows) {
      for (const mode of modes) {
        const entry: HoverRowResult = { ...row, mode, outcome: "stable", reason: null };
        result.rows.push(entry);
        await measure(row.index, mode, entry);
        // Coverage counts only a completed measurement of this row in this mode.
        if (entry.outcome === "stable" || entry.outcome === "shifted") {
          for (const item of coverage) if (item.mode === mode && (entry.matches ?? []).includes(item.selector)) item.measured = true;
        }
      }
    }
    const missing = coverage.filter(item => !item.measured);
    if (missing.length) Object.assign(result, { outcome: "error", reason: `required rows not measured: ${missing.map(m => `${m.selector} (${m.mode})`).join(", ").slice(0, 280)}` });
    else if (result.rows.some(r => r.outcome === "error")) Object.assign(result, { outcome: "error", reason: "a row measurement failed" });
    else if (result.rows.some(r => r.outcome === "shifted")) result.outcome = "shifted";
  } catch (error) {
    Object.assign(result, { outcome: "error", reason: String(error instanceof Error ? error.message : error).split("\n")[0]!.slice(0, 300) });
  }
  return result;

  /** Move to a neutral point and blur; a reason when no row-free point exists or a row still reports :hover. */
  async function park(): Promise<string | null> {
    const point = await page.evaluate(NEUTRAL_POINT, spec.rows);
    if (!point) return "no point outside the rows to park the pointer";
    // One move straight to the point: stepping there would hover the rows it crosses before rest is taken.
    await page.mouse.move(point.x, point.y);
    await page.evaluate(BLUR, null);
    const hovered = await page.evaluate(HOVERED_ROWS, spec.rows);
    return hovered > 0 ? `${hovered} row(s) still hovered with the pointer parked` : null;
  }

  async function measure(index: number, mode: "hover" | "focus", entry: HoverRowResult): Promise<void> {
    const row = { index, preferred: entry.preferred };
    // Bring the row (found again by key if the list was rebuilt) into view; PROBE re-finds it after settling.
    await page.evaluate(REMARK, { index, key: entry.key, rows: spec.rows });
    await page.locator(`[data-audit-hover-row="${row.index}"]`).first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    // Park the pointer outside every row of the list (setup clicks leave it over a control), then take rest.
    const parked = await park();
    if (parked) { Object.assign(entry, { outcome: "error", reason: `rest: ${parked}` }); return; }
    const rest = await page.evaluate(PROBE, { index: row.index, key: entry.key, rows: spec.rows, phase: "rest", tolerance }) as ProbeError | ProbeRest;
    if (failed(rest)) { Object.assign(entry, { outcome: "error", reason: rest.error }); return; }
    // Coverage is decided on the live row this measurement uses, not the row first chosen.
    entry.matches = required.length ? await page.evaluate(ROW_MATCHES, { index: row.index, selectors: required }) : [];
    if (rest.drift > 0) { Object.assign(entry, { outcome: "unstable", reason: `${rest.drift} box(es) moved at rest` }); return; }
    // The first preferred row is photographed at rest and in each mode.
    const preferredShot = !!shot && !shotTaken.has(mode) && row.preferred;
    if (preferredShot && mode === "hover") await shot!(`hover-${spec.name}-rest`);
    if (mode === "hover") {
      entry.point = await page.evaluate(HOVER_POINT, row.index);
      if (!entry.point) { Object.assign(entry, { outcome: "skipped", reason: "no point of the row receives the pointer" }); return; }
      await page.mouse.move(entry.point.x, entry.point.y, { steps: 2 });
    } else {
      entry.focused = await page.evaluate(FOCUS_ROW, { index: row.index, target: spec.focusTarget });
      // A named target that cannot take focus is a failed measurement; without one, a row with no control is skipped.
      if (!entry.focused) { Object.assign(entry, spec.focusTarget ? { outcome: "error", reason: `could not focus ${spec.focusTarget}` } : { outcome: "skipped", reason: "no focusable control in the row" }); return; }
    }
    const early = await page.evaluate(PROBE, { index: row.index, rows: spec.rows, phase: "early", tolerance }) as ProbeError | ProbeCompared;
    const late = await page.evaluate(PROBE, { index: row.index, rows: spec.rows, phase: "late", tolerance }) as ProbeError | ProbeCompared;
    if (failed(early) || failed(late)) { Object.assign(entry, { outcome: "error", reason: failed(early) ? early.error : (late as ProbeError).error }); return; }
    Object.assign(entry, { early, late });
    // The state being measured must still hold at both reads, or the measurement proves nothing.
    const held = mode === "hover" ? early.hoverMatched && late.hoverMatched : early.focusWithin && late.focusWithin;
    if (!held) { Object.assign(entry, { outcome: "error", reason: mode === "hover" ? "hover was not held during the measurement" : "focus was lost during the measurement" }); return; }
    if (early.shifted + late.shifted > 0) entry.outcome = "shifted";
    if (preferredShot) { await shot!(`hover-${spec.name}-${mode}`); shotTaken.add(mode); }
    // Leaving must restore rest exactly as well: a failed or moved return is a failure too.
    const left = await park();
    if (left) { Object.assign(entry, { outcome: "error", reason: `return to rest: ${left}` }); return; }
    const restored = await page.evaluate(PROBE, { index: row.index, rows: spec.rows, phase: "late", tolerance }) as ProbeError | ProbeCompared;
    if (failed(restored)) { Object.assign(entry, { outcome: "error", reason: `return to rest: ${restored.error}`, restoredShifts: -1 }); return; }
    Object.assign(entry, { restored, restoredShifts: restored.shifted });
    if (restored.shifted > 0) entry.outcome = "shifted";
  }
}

export type HoverResult = Awaited<ReturnType<typeof runHoverWitness>>;

/** Counters for the report. `shifted` and `error` fail the audit; the rest say how much was really measured. */
export function hoverSummary(results: HoverResult[]) {
  const rows = results.flatMap(r => r.rows);
  return {
    specs: results.length,
    shifted: results.filter(r => r.outcome === "shifted").length,
    error: results.filter(r => r.outcome === "error").length,
    rowsMeasured: rows.filter(r => r.outcome === "stable" || r.outcome === "shifted").length,
    rowsShifted: rows.filter(r => r.outcome === "shifted").length,
    rowsUnstable: rows.filter(r => r.outcome === "unstable").length,
    rowsSkipped: rows.filter(r => r.outcome === "skipped").length,
    // A hover the browser did not apply proves nothing; these say where hover really matched.
    hoverNotMatched: rows.filter(r => r.mode === "hover" && r.early && !r.early.hoverMatched).length,
    withoutHoverMedia: results.filter(r => r.hoverCapable === false).length,
    notRestored: rows.filter(r => (r.restoredShifts ?? 0) !== 0).length,
    addressedRowsMeasured: rows.filter(r => r.targetKind !== null && r.targetKind !== "everyone" && (r.outcome === "stable" || r.outcome === "shifted")).length,
  };
}

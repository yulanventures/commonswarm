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
  const ordered = [...new Set([...required, ...preferred, ...all])].slice(0, Math.max(spec.max, required.length));
  return {
    found: all.length,
    rows: ordered.map((el, index) => {
      el.setAttribute("data-audit-hover-row", String(index));
      const target = el.querySelector("[data-target-kind]");
      return {
        index,
        preferred: preferred.includes(el),
        targetKind: target?.getAttribute("data-target-kind") ?? null,
        authorKind: el.querySelector("[data-author-kind]")?.getAttribute("data-author-kind")
          ?? (el.querySelector(".dashboard__message-identity-badge")?.textContent?.trim().toLowerCase() || null),
      };
    }),
  };
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
type ProbeCompared = { shifted: number; shifts: Shift[]; hoverMatched: boolean; focusWithin: boolean; focusVisible: boolean };
const PROBE = async (arg: { index: number; rows: string; phase: "rest" | "early" | "late"; tolerance: number }): Promise<ProbeError | ProbeRest | ProbeCompared> => {
  type Rect = { x: number; y: number; w: number; h: number };
  type Tracked = { el: Element | Range; who: "row" | "inside" | "text" | "other-row"; label: string };
  const w = globalThis as unknown as { __auditHoverRest?: { tracked: Tracked[]; rects: Rect[][] } };
  const frame = () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  // An element is one box; a text node is every line fragment it lays out, so a re-wrap that keeps
  // every element box (same width, same line count) still moves a fragment.
  const rectsOf = (el: Element | Range): Rect[] => {
    const list = el instanceof Range ? Array.from(el.getClientRects()) : [el.getBoundingClientRect()];
    return list.filter(r => r.width > 0 || r.height > 0).map(r => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
  };
  const describe = (el: Element) => {
    const classes = Array.from(el.classList).slice(0, 2).map(c => `.${c}`).join("");
    const data = Array.from(el.attributes).find(a => a.name.startsWith("data-") && a.name !== "data-audit-hover-row");
    return `${el.tagName.toLowerCase()}${classes}${data ? `[${data.name}]` : ""}`;
  };
  const delta = (a: Rect[], b: Rect[]) => a.length !== b.length ? Infinity
    : Math.max(0, ...a.map((r, i) => Math.max(Math.abs(r.x - b[i]!.x), Math.abs(r.y - b[i]!.y), Math.abs(r.w - b[i]!.w), Math.abs(r.h - b[i]!.h))));
  const row = document.querySelector(`[data-audit-hover-row="${arg.index}"]`);
  if (!row) return { error: "row gone" };
  if (arg.phase === "rest") {
    const tracked: Tracked[] = [{ el: row, who: "row", label: describe(row) }];
    for (const el of Array.from(row.querySelectorAll("*")).slice(0, 400)) tracked.push({ el, who: "inside", label: describe(el) });
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    let texts = 0;
    for (let node = walker.nextNode(); node && texts < 120; node = walker.nextNode()) {
      const range = document.createRange(); range.selectNodeContents(node);
      if (!range.getClientRects().length) continue; // Not laid out at rest (inside a hidden element).
      texts += 1;
      tracked.push({ el: range, who: "text", label: `text in ${node.parentElement ? describe(node.parentElement) : "row"}` });
    }
    for (const other of Array.from(document.querySelectorAll(arg.rows)).slice(0, 80)) {
      if (other !== row && !row.contains(other) && !other.contains(row)) tracked.push({ el: other, who: "other-row", label: describe(other) });
    }
    await new Promise(done => setTimeout(done, 300));
    await frame();
    const first = tracked.map(t => rectsOf(t.el));
    await frame();
    const second = tracked.map(t => rectsOf(t.el));
    const drift = first.filter((r, i) => r.length > 0 && delta(r, second[i]!) > arg.tolerance).length;
    w.__auditHoverRest = { tracked, rects: second };
    return { tracked: tracked.length, measured: second.filter(r => r.length > 0).length, drift };
  }
  const rest = w.__auditHoverRest;
  if (!rest) return { error: "no rest snapshot" };
  if (arg.phase === "early") await frame(); else { await new Promise(done => setTimeout(done, 400)); await frame(); }
  const shifts: Shift[] = [];
  const round = (n: number) => Math.round(n * 100) / 100;
  rest.tracked.forEach((t, i) => {
    const before = rest.rects[i]!;
    if (!before.length) return; // Not rendered at rest: something revealed on hover is not itself a shift.
    const now = rectsOf(t.el);
    if (delta(before, now) <= arg.tolerance) return;
    if (now.length === 0) { shifts.push({ who: t.who, label: t.label, dx: 0, dy: 0, dw: 0, dh: 0, gone: true }); return; }
    // Report the fragment that moved most (or the first, when the line count itself changed).
    const pairs = before.map((r, k) => [r, now[Math.min(k, now.length - 1)]!] as const);
    const [b, n] = pairs.reduce((worst, pair) => delta([pair[0]], [pair[1]]) > delta([worst[0]], [worst[1]]) ? pair : worst, pairs[0]!);
    shifts.push({ who: t.who, label: t.label, dx: round(n.x - b.x), dy: round(n.y - b.y), dw: round(n.w - b.w), dh: round(n.h - b.h), gone: false,
      ...(before.length !== now.length ? { lines: [before.length, now.length] as [number, number] } : {}) });
  });
  const active = document.activeElement;
  return {
    shifted: shifts.length,
    shifts: shifts.sort((a, b) => Number(b.gone) - Number(a.gone) || Math.max(Math.abs(b.dx), Math.abs(b.dy), Math.abs(b.dw), Math.abs(b.dh)) - Math.max(Math.abs(a.dx), Math.abs(a.dy), Math.abs(a.dw), Math.abs(a.dh))).slice(0, 6),
    hoverMatched: row.matches(":hover"),
    focusWithin: row.matches(":focus-within"),
    focusVisible: !!active && active !== document.body && active.matches(":focus-visible"),
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
const BLUR = (_: null) => { (document.activeElement as HTMLElement | null)?.blur?.(); };
const HOVER_CAPABLE = (_: null) => matchMedia("(hover: hover)").matches;

type Compared = ProbeCompared;
const failed = (p: ProbeError | ProbeRest | ProbeCompared): p is ProbeError => "error" in p;
export type HoverRowResult = {
  index: number; preferred: boolean; targetKind: string | null; authorKind: string | null; mode: "hover" | "focus";
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
      const matches = required.length ? await page.evaluate(ROW_MATCHES, { index: row.index, selectors: required }) : [];
      for (const mode of modes) {
        const entry: HoverRowResult = { ...row, mode, outcome: "stable", reason: null };
        result.rows.push(entry);
        await measure(row.index, mode, entry);
        // Coverage counts only a completed measurement of this row in this mode.
        if (entry.outcome === "stable" || entry.outcome === "shifted") {
          for (const item of coverage) if (item.mode === mode && matches.includes(item.selector)) item.measured = true;
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

  async function measure(index: number, mode: "hover" | "focus", entry: HoverRowResult): Promise<void> {
    const row = { index, preferred: entry.preferred };
    await page.locator(`[data-audit-hover-row="${row.index}"]`).first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    // Park the pointer away from the list (setup clicks leave it over a control), then take rest.
    await page.mouse.move(1, 1);
    await page.evaluate(BLUR, null);
    const rest = await page.evaluate(PROBE, { index: row.index, rows: spec.rows, phase: "rest", tolerance }) as ProbeError | ProbeRest;
    if (failed(rest)) { Object.assign(entry, { outcome: "error", reason: rest.error }); return; }
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
    if (early.shifted + late.shifted > 0) entry.outcome = "shifted";
    if (preferredShot) { await shot!(`hover-${spec.name}-${mode}`); shotTaken.add(mode); }
    // Leaving must restore rest exactly as well: a failed or moved return is a failure too.
    await page.mouse.move(1, 1);
    await page.evaluate(BLUR, null);
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

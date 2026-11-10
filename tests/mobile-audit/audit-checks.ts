/**
 * In-page measurements for the mobile audit, shared by the CI runner (run-mobile-audit.ts) and the
 * fixture regression matrix (witness-matrix.ts). Every function here runs inside the browser page.
 *
 * Order per capture: CHECKS (the raw lists, unchanged) -> primary screenshot -> GEOMETRY_WITNESS
 * (read-only) -> keyboard witnesses (native keys; they change focus and may navigate, so they run last).
 */
/** Runs in the page: overflow, small tap targets and horizontally clipped controls. */
export const CHECKS = () => {
  const describe = (el: Element) => {
    const h = el as HTMLElement;
    const data = [...h.attributes].find(a => a.name.startsWith("data-"))?.name;
    return `${el.tagName.toLowerCase()}${h.id ? `#${h.id}` : ""}${data ? `[${data}]` : ""}${typeof h.className === "string" && h.className ? `.${h.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`;
  };
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    // Content of a closed <details> (anything but its own summary) is not shown, even when the
    // engine still reports a box for it (::details-content).
    const closed = el.closest("details:not([open])");
    if (closed && !closed.querySelector(":scope > summary")?.contains(el)) return false;
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05 && !el.closest("[hidden],[inert]");
  };
  const inScroller = (el: Element) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
    return false;
  };
  const width = window.innerWidth;
  const doc = document.scrollingElement ?? document.documentElement;
  const offenders = doc.scrollWidth > doc.clientWidth + 1
    ? [...document.querySelectorAll("body *")].filter(el => visible(el) && el.getBoundingClientRect().right > width + 1 && !inScroller(el)).slice(0, 15).map(describe) : [];
  // The ONLY effective-hitbox rule: a checkbox or radio inside (or named by) a label is tapped
  // through that label, so it is measured by the label's box. Every such use is listed in
  // `effective` with both sizes; nothing else is measured by anything but its own box.
  const labelFor = (el: Element) => el.tagName === "INPUT" && ["checkbox", "radio"].includes((el as HTMLInputElement).type)
    ? (el.closest("label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null)) : null;
  // One collection, run once here for the raw lists; the post-screenshot witness runs it again on the live page.
  const collect = () => {
    const interactive = [...document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=menuitem],[role=tab],[role=option]")].filter(visible);
    const measured = interactive.map(el => {
      const own = el.getBoundingClientRect();
      const label = labelFor(el)?.getBoundingClientRect();
      const viaLabel = !!label && label.width * label.height > own.width * own.height;
      return { el, own, rect: viaLabel ? label! : own, viaLabel };
    });
    return { interactive, measured };
  };
  const { interactive, measured } = collect();
  const effective = measured.filter(m => m.viaLabel).slice(0, 40).map(m => ({ selector: describe(m.el), via: "label",
    own: { w: Math.round(m.own.width), h: Math.round(m.own.height) }, hit: { w: Math.round(m.rect.width), h: Math.round(m.rect.height) } }));
  const small = measured
    .filter(({ el, rect }) => (rect.width < 44 || rect.height < 44) && !(el.tagName === "A" && getComputedStyle(el).display === "inline"))
    .slice(0, 60);
  const tapTargets = small.map(({ el, rect, viaLabel }) => ({ selector: describe(el), w: Math.round(rect.width), h: Math.round(rect.height), ...(viaLabel ? { via: "label" } : {}) }));
  // Hit testing: the centre of each measured box must reach the control (or its label).
  const reaches = (el: Element, x: number, y: number) => {
    const hit = document.elementFromPoint(x, y);
    const label = labelFor(el);
    return !!hit && (el === hit || el.contains(hit) || (!!label && (label === hit || label.contains(hit))));
  };
  // While a modal dialog is open, only its own controls can be tapped: judge those alone.
  const modal = [...document.querySelectorAll("dialog[open]")].find(d => d.matches(":modal"));
  const tappable = modal ? measured.filter(m => modal.contains(m.el)) : measured;
  const centreInView = (r: DOMRect) => { const x = r.left + r.width / 2, y = r.top + r.height / 2; return x >= 0 && y >= 0 && x < width && y < window.innerHeight; };
  // Scrolling, not a defect: a centre clipped by the target's own scroll container, or content
  // passing under a fixed or sticky bar. Both are skipped; anything else covering a target counts.
  const pinned = (el: Element | null) => { for (let n = el; n; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === "fixed" || p === "sticky") return true; } return false; };
  const clipped = (el: Element, x: number, y: number) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (/(auto|scroll|hidden|clip)/u.test(st.overflowX + st.overflowY)) {
        const r = n.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return true;
      }
    }
    return false;
  };
  const scrolledAway = (m: { el: Element; rect: DOMRect }) => {
    const x = m.rect.left + m.rect.width / 2, y = m.rect.top + m.rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return clipped(m.el, x, y) || (pinned(hit) && !pinned(m.el));
  };
  const obscured = tappable.filter(m => centreInView(m.rect) && !scrolledAway(m) && !reaches(m.el, m.rect.left + m.rect.width / 2, m.rect.top + m.rect.height / 2))
    .slice(0, 20).map(m => ({ selector: describe(m.el), by: describe(document.elementFromPoint(m.rect.left + m.rect.width / 2, m.rect.top + m.rect.height / 2) ?? document.body) }));
  // Non-overlap: two different controls whose measured boxes intersect by more than 4px² share taps.
  const pin = new Map(tappable.map(m => [m.el, pinned(m.el)] as const));
  const overlaps: { a: string; b: string; area: number }[] = [];
  const overlapPairs: [typeof tappable[number], typeof tappable[number]][] = [];
  for (let i = 0; i < tappable.length && overlaps.length < 20; i += 1) {
    for (let j = i + 1; j < tappable.length && overlaps.length < 20; j += 1) {
      const a = tappable[i]!, b = tappable[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el) || labelFor(a.el)?.contains(b.el) || labelFor(b.el)?.contains(a.el)) continue;
      if (pin.get(a.el) !== pin.get(b.el)) continue; // scrolling content under a fixed or sticky bar
      const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (w > 0 && h > 0 && w * h > 4) { overlaps.push({ a: describe(a.el), b: describe(b.el), area: Math.round(w * h) }); overlapPairs.push([a, b]); }
    }
  }
  const offscreen = interactive.filter(el => { const r = el.getBoundingClientRect(); return (r.left < -1 || r.right > width + 1) && !inScroller(el); }).slice(0, 20).map(describe);
  // Collapsed text: a visible element holding a sentence but squeezed into a sliver, so it
  // wraps a character or two per line (overflow cannot see it). Leaf text containers only.
  const collapsed = [...document.querySelectorAll("body *")].filter(el => {
    if (!visible(el) || el.children.length > 2) return false;
    const text = (el.textContent ?? "").trim();
    if (text.length < 12 || !/\s/u.test(text)) return false;
    const r = el.getBoundingClientRect();
    const line = parseFloat(getComputedStyle(el).lineHeight) || 16;
    return r.width < 48 && r.height > line * 4;
  }).slice(0, 10).map(el => ({ selector: describe(el), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }));
  const root = document.documentElement.getAttribute("data-theme");
  const effectiveTheme = root === "light" || root === "dark" ? root : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  // The raw measurement's own elements and helpers, for the witnesses that run after the primary screenshot.
  (globalThis as unknown as { __auditRaw?: AuditRaw }).__auditRaw = { describe, visible, reaches, collect, measured, small, overlapPairs, modal: modal ?? null };
  return { overflow: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders }, tapTargets, offscreen, effective, obscured, overlaps, collapsed, effectiveTheme };
};

type Box = { left: number; top: number; right: number; bottom: number };
type Measured = { el: Element; own: DOMRect; rect: DOMRect; viaLabel: boolean };
/** What CHECKS leaves behind for the witnesses: its own helpers and the elements behind its raw lists. */
export type AuditRaw = {
  describe: (el: Element) => string;
  visible: (el: Element) => boolean;
  reaches: (el: Element, x: number, y: number) => boolean;
  /** Re-collects the controls exactly as the raw lists did, on the page as it is now. */
  collect: () => { interactive: Element[]; measured: Measured[] };
  /** The raw measurement's own elements and rectangles, taken before the primary screenshot. */
  measured: Measured[];
  small: Measured[];
  overlapPairs: [Measured, Measured][];
  modal: Element | null;
};
type Reach = { reached: number; sampled: number; by: string | null };
/** Helpers the keyboard witness reuses; GEOMETRY_WITNESS installs them. */
export type WitnessHelpers = {
  describe: (el: Element) => string;
  opacityChain: (el: Element) => number;
  clippedBy: (el: Element) => string | null;
  foreground: (el: Element) => Reach;
};

/**
 * Read-only geometry witnesses. Runs in the page AFTER CHECKS and the primary screenshot, on the
 * elements CHECKS measured, and returns findings beside (never instead of) the raw lists.
 * `declared` names overlay roots the generic rules cannot recognise (an `aside` profile panel,
 * a picker's list); a declared root counts only while it is shown.
 */
export const GEOMETRY_WITNESS = (declared: string[]) => {
  const raw = (globalThis as unknown as { __auditRaw?: AuditRaw }).__auditRaw;
  if (!raw) throw new Error("CHECKS must run before GEOMETRY_WITNESS");
  const { describe, visible, reaches, collect, measured: rawMeasured, small, overlapPairs, modal } = raw;
  const width = window.innerWidth, height = window.innerHeight;
  // Judge the page as it is NOW (after the screenshot), not the elements and rectangles CHECKS saved
  // before it: content can re-render in between (a dialog that renders, then renders again when a
  // read lands). The raw references are compared with the live ones and the drift is reported; a
  // raw-indexed fact whose element is gone or hidden says so (`stale`) instead of a hit finding.
  const { interactive, measured } = collect();
  const live = new Map(measured.map(m => [m.el, m] as const));
  const movedBetween = (a: DOMRect, b: DOMRect) => [a.left - b.left, a.top - b.top, a.width - b.width, a.height - b.height].some(d => Math.abs(d) > 1);
  const staleOf = (m: Measured) => (!m.el.isConnected ? "detached" : !live.has(m.el) ? "hidden" : null);
  const rawEls = new Set(rawMeasured.map(m => m.el));
  const drift = {
    rawControls: rawMeasured.length, liveControls: measured.length,
    detached: rawMeasured.filter(m => staleOf(m) === "detached").length,
    hidden: rawMeasured.filter(m => staleOf(m) === "hidden").length,
    moved: rawMeasured.filter(m => { const now = live.get(m.el); return !!now && movedBetween(m.rect, now.rect); }).length,
    added: measured.filter(m => !rawEls.has(m.el)).length,
  };
  const round = (n: number) => Math.round(n);
  const inView = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  const hitAt = (x: number, y: number) => describe(document.elementFromPoint(x, y) ?? document.body);
  const centreOf = (r: Box) => [(r.left + r.right) / 2, (r.top + r.bottom) / 2] as const;
  const boxOf = (r: Box) => ({ x: round(r.left), y: round(r.top), w: round(r.right - r.left), h: round(r.bottom - r.top) });

  /** Product of the element's and its ancestors' opacity: what is actually painted. */
  const opacityChain = (el: Element) => {
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return Math.round(o * 100) / 100;
  };
  /** The nearest box that hides the element: a 50% inset clip-path, a <=2px overflow-hidden box, or an
   *  overflow-hidden ancestor that excludes its centre. Scrollers (auto/scroll) scroll; they do not hide. */
  const clippedBy = (el: Element) => {
    const [cx, cy] = centreOf(el.getBoundingClientRect());
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (/inset\(\s*50%/u.test(st.clipPath)) return describe(n);
      if (!/(hidden|clip)/u.test(st.overflowX + st.overflowY)) continue;
      const nr = n.getBoundingClientRect();
      if (nr.width <= 2 || nr.height <= 2) return describe(n);
      if (n !== el && (cx < nr.left || cx > nr.right || cy < nr.top || cy > nr.bottom)) return describe(n);
    }
    return null;
  };
  /** Viewport ∩ every non-visible-overflow ancestor's client area (scrollbars excluded). */
  const shownPart = (r: Box, owners: Element[]): Box => {
    let { left, top, right, bottom } = r;
    left = Math.max(left, 0); top = Math.max(top, 0); right = Math.min(right, width); bottom = Math.min(bottom, height);
    for (const owner of owners) {
      for (let n = owner.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        const st = getComputedStyle(n);
        if (st.overflowX === "visible" && st.overflowY === "visible") continue;
        const nr = n.getBoundingClientRect();
        const cl = nr.left + n.clientLeft, ct = nr.top + n.clientTop;
        left = Math.max(left, cl); top = Math.max(top, ct); right = Math.min(right, cl + n.clientWidth); bottom = Math.min(bottom, ct + n.clientHeight);
      }
    }
    return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
  };
  const areaOf = (r: Box) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  /** Up to five points (centre, then 25%/75% corners) inside the shown part of a box. */
  const samples = (r: Box, owner: Element) => {
    const s = shownPart(r, [owner]);
    if (s.right - s.left < 1 || s.bottom - s.top < 1) return [];
    return [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]
      .map(([fx, fy]) => [s.left + (s.right - s.left) * fx!, s.top + (s.bottom - s.top) * fy!] as const);
  };
  const foreground = (el: Element, r: Box = el.getBoundingClientRect()): Reach => {
    const points = samples(r, el);
    const reached = points.filter(([x, y]) => reaches(el, x, y)).length;
    return { reached, sampled: points.length, by: reached === 0 && points[0] ? hitAt(points[0][0], points[0][1]) : null };
  };
  const pointShown = (owner: Element, x: number, y: number) => { const s = shownPart({ left: x, top: y, right: x + 0.5, bottom: y + 0.5 }, [owner]); return areaOf(s) > 0; };

  // ---- (1) Overlays and what they cover ----
  // The raw check judges only the FIRST open modal in DOM order. Paint order decides what is in
  // front: the foreground is the innermost overlay that its own box still receives hits on (a
  // modal's backdrop takes every hit beneath it). Menus, listboxes and dialogs count when they are
  // positioned; native dialogs, popovers and declared roots count whenever they are shown.
  const popovers = (() => { try { return [...document.querySelectorAll(":popover-open")]; } catch { return []; } })();
  const declaredEls = declared.flatMap(sel => [...document.querySelectorAll(sel)]);
  const overlayEls = [...new Set([...document.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"], [role="menu"], [role="listbox"]'), ...popovers, ...declaredEls])]
    .filter(el => {
      if (!visible(el)) return false;
      if (el.tagName === "DIALOG" || popovers.includes(el) || declaredEls.includes(el)) return true;
      const position = getComputedStyle(el).position;
      return position === "fixed" || position === "absolute";
    })
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const overlays = overlayEls.map(el => {
    const points = samples(el.getBoundingClientRect(), el);
    const reached = points.filter(([x, y]) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === el || el.contains(hit)); }).length;
    let isModal = false;
    try { isModal = el.matches(":modal"); } catch { /* engine without :modal */ }
    return { el, modal: isModal, declared: declaredEls.includes(el), reached };
  });
  const exposed = overlays.filter(o => o.reached > 0);
  const front = exposed.filter(o => !exposed.some(p => p !== o && o.el.contains(p.el))).at(-1)?.el ?? null;
  const within = (root: Element | null, el: Element | null) => !!root && !!el && (root === el || root.contains(el));
  // A control counts when its centre is actually shown (viewport and every clipping parent's client
  // area). Unlike the raw check, a fixed or sticky element over it is NOT excused: it is recorded
  // as the covering element, flagged pinnedCover, because a tap there really goes to it.
  const pinned = (el: Element | null) => { for (let n = el; n; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === "fixed" || p === "sticky") return true; } return false; };
  const centreShown = (m: Measured) => { const [x, y] = centreOf(m.rect); return inView(x, y) && pointShown(m.el, x, y); };
  const blocked = measured.filter(m => centreShown(m) && !reaches(m.el, ...centreOf(m.rect)))
    .map(m => {
      const hit = document.elementFromPoint(...centreOf(m.rect));
      return { m, hit, row: { selector: describe(m.el), by: hit ? describe(hit) : null, ...(pinned(hit) && !pinned(m.el) ? { pinnedCover: true } : {}) } };
    });
  const foregroundObscured = blocked.filter(b => within(front, b.m.el)).map(b => b.row);
  const byForeground = blocked.filter(b => !within(front, b.m.el) && within(front, b.hit)).map(b => b.row);
  const byOtherOverlay = blocked.filter(b => !within(front, b.m.el) && !within(front, b.hit) && overlayEls.some(o => within(o, b.hit))).map(b => b.row);
  const unexpectedObscured = blocked.filter(b => !within(front, b.m.el) && !overlayEls.some(o => within(o, b.hit))).map(b => b.row);
  const frontControls = front ? measured.filter(m => within(front, m.el) && centreShown(m)) : [];
  const overlay = {
    rawModal: modal ? describe(modal) : null,
    front: front ? describe(front) : null,
    open: overlays.slice(0, 10).map(o => ({ selector: describe(o.el), modal: o.modal, declared: o.declared, reached: o.reached })),
    frontControls: { inView: frontControls.length, reached: frontControls.filter(m => reaches(m.el, ...centreOf(m.rect))).length },
  };

  // ---- Small targets, index for index with tapTargets ----
  // Text beside a control is context, not an exemption: `inlineInText` marks only a control laid out
  // inline within running text; a block-level control beside text is still a discrete target.
  const tapTargetFacts = small.map(rawTarget => {
    const { el } = rawTarget;
    const stale = staleOf(rawTarget);
    if (stale) return { selector: describe(el), stale, moved: false, layer: "stale", reached: 0, sampled: 0, by: null, display: "", fragments: 0, inText: false, inlineInText: false, opacity: 0, clippedBy: null };
    const { rect } = live.get(el)!;
    const display = getComputedStyle(el).display;
    const inText = [...(el.parentElement?.childNodes ?? [])].some(n => n !== el && n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "");
    return {
      selector: describe(el),
      stale: null,
      moved: movedBetween(rawTarget.rect, rect),
      layer: !front ? "page" : within(front, el) ? "front" : "behind",
      ...foreground(el, rect),
      display,
      fragments: el.getClientRects().length,
      inText,
      inlineInText: inText && display.startsWith("inline"),
      opacity: opacityChain(el),
      clippedBy: clippedBy(el),
    };
  });

  // ---- (2) Links: label fragments when the union-box centre misses ----
  // Any display: an inline anchor wraps into line fragments; an inline-flex anchor has one box whose
  // label may sit under a neighbour. Each visible label fragment is tested on its own, so one
  // passing fragment never hides a covered one. hitHref names a different link that took the hit.
  const labelFragments = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const seen = new Set<string>();
    const label = [...range.getClientRects()].filter(r => r.width >= 1 && r.height >= 1)
      .filter(r => { const key = `${round(r.left)},${round(r.top)},${round(r.width)},${round(r.height)}`; if (seen.has(key)) return false; seen.add(key); return true; });
    return { source: label.length ? "label" : "box", rects: label.length ? label : [...el.getClientRects()].filter(r => r.width >= 1 && r.height >= 1) };
  };
  const fragmentFacts = (el: Element) => {
    const { source, rects } = labelFragments(el);
    const fragments = rects.map(r => {
      const [x, y] = centreOf(r);
      const shown = inView(x, y) && pointShown(el, x, y);
      const hit = shown ? document.elementFromPoint(x, y) : null;
      const other = hit?.closest("a[href]");
      // Behind the front overlay, a fragment that overlay covers is expected coverage, not a blocked link.
      const coveredByFront = shown && !within(front, el) && within(front, hit);
      return { ...boxOf(r), point: [round(x), round(y)], shown, hit: hit ? describe(hit) : null, reached: shown && reaches(el, x, y), coveredByFront,
        ...(other && other !== el && !el.contains(other) ? { hitHref: other.getAttribute("href") } : {}) };
    });
    const shown = fragments.filter(f => f.shown), judged = shown.filter(f => !f.coveredByFront), ok = judged.filter(f => f.reached).length;
    const outcome = !shown.length ? "not-in-view" : !judged.length ? "covered-by-front"
      : ok === judged.length ? "all-hit" : ok === 0 ? "all-blocked" : "mixed";
    return { source, outcome, fragments };
  };
  // Each fragment is classified by who actually receives its hit: the front overlay (expected
  // coverage) or anything else (a finding, even for a link that sits behind the front overlay).
  // Links whose every shown fragment the front covers are kept, with all their fragment records, in
  // linksCoveredByFront rather than in links, so they cannot crowd real findings out of the list.
  const linkFacts = interactive.filter(el => el.tagName === "A").flatMap(el => {
    const [cx, cy] = centreOf(el.getBoundingClientRect());
    if (!inView(cx, cy) || !pointShown(el, cx, cy) || reaches(el, cx, cy)) return [];
    const facts = fragmentFacts(el);
    return [{ selector: describe(el), href: el.getAttribute("href"), layer: !front ? "page" : within(front, el) ? "front" : "behind", display: getComputedStyle(el).display,
      text: (el.textContent ?? "").trim().slice(0, 40), unionHit: hitAt(cx, cy), source: facts.source, outcome: facts.outcome, fragments: facts.fragments.slice(0, 8) }];
  });
  const links = linkFacts.filter(l => l.outcome !== "covered-by-front").slice(0, 30);
  const linksCoveredByFront = linkFacts.filter(l => l.outcome === "covered-by-front").slice(0, 30);

  // ---- Disclosure summaries (legal contents): open state, pointer-events, and whether the links they reveal are reachable ----
  const summaries = [...document.querySelectorAll("details > summary")].filter(visible).slice(0, 10).map(s => {
    const details = s.parentElement as HTMLDetailsElement;
    const contents = [...details.querySelectorAll("a[href]")].filter(a => visible(a) && !s.contains(a));
    const facts = contents.map(a => fragmentFacts(a)).filter(f => f.outcome !== "not-in-view");
    return { selector: describe(s), open: details.open, pointerEvents: getComputedStyle(s).pointerEvents, ...foreground(s),
      contents: { links: contents.length, inView: facts.length, reached: facts.filter(f => f.outcome === "all-hit" || f.outcome === "mixed").length,
        mixedOrBlocked: facts.filter(f => f.outcome === "mixed" || f.outcome === "all-blocked").length } };
  });

  // ---- (4) Overlaps, index for index with the raw `overlaps` ----
  // Shown vs clipped shared area, and who receives a tap at each intended point: each control's
  // centre and the centre of its largest strip outside the other control.
  const ownPoint = (r: DOMRect, o: DOMRect) => {
    const strips: Box[] = [
      { left: r.left, right: Math.min(r.right, o.left), top: r.top, bottom: r.bottom },
      { left: Math.max(r.left, o.right), right: r.right, top: r.top, bottom: r.bottom },
      { left: r.left, right: r.right, top: r.top, bottom: Math.min(r.bottom, o.top) },
      { left: r.left, right: r.right, top: Math.max(r.top, o.bottom), bottom: r.bottom },
    ].filter(s => s.right - s.left >= 1 && s.bottom - s.top >= 1).sort((p, q) => areaOf(q) - areaOf(p));
    return strips[0] ? centreOf(strips[0]) : null;
  };
  const overlapFacts = overlapPairs.map(([rawA, rawB]) => {
    const a = live.get(rawA.el), b = live.get(rawB.el);
    if (!a || !b) return { a: describe(rawA.el), b: describe(rawB.el), stale: staleOf(rawA) ?? staleOf(rawB), moved: false, area: 0, visibleArea: 0, clippedArea: 0, kind: "stale", wrongTarget: false, points: null };
    const shared: Box = { left: Math.max(a.rect.left, b.rect.left), right: Math.min(a.rect.right, b.rect.right),
      top: Math.max(a.rect.top, b.rect.top), bottom: Math.min(a.rect.bottom, b.rect.bottom) };
    const area = round(areaOf(shared)), visibleArea = round(areaOf(shownPart(shared, [a.el, b.el])));
    const probe = (intended: Measured, other: Measured, p: readonly [number, number] | null) => {
      if (!p) return null;
      const shown = inView(...p) && pointShown(intended.el, ...p);
      const hit = shown ? document.elementFromPoint(...p) : null;
      return { point: [round(p[0]), round(p[1])], shown, recipient: hit ? describe(hit) : null, ok: shown && reaches(intended.el, ...p),
        toOther: shown && reaches(other.el, ...p) };
    };
    const points = { aCentre: probe(a, b, centreOf(a.rect)), bCentre: probe(b, a, centreOf(b.rect)), aOwn: probe(a, b, ownPoint(a.rect, b.rect)), bOwn: probe(b, a, ownPoint(b.rect, a.rect)) };
    const wrongTarget = Object.values(points).some(p => !!p && p.shown && !p.ok && p.toOther);
    return { a: describe(a.el), b: describe(b.el), stale: null, moved: movedBetween(rawA.rect, a.rect) || movedBetween(rawB.rect, b.rect),
      area, visibleArea, clippedArea: area - visibleArea, kind: visibleArea > 4 ? "visible" : "clipped", wrongTarget, points };
  });

  const media = { hoverNone: matchMedia("(hover: none)").matches, pointerCoarse: matchMedia("(pointer: coarse)").matches, anyHover: matchMedia("(any-hover: hover)").matches };
  (globalThis as unknown as { __auditHelpers?: WitnessHelpers }).__auditHelpers = { describe, opacityChain, clippedBy, foreground: (el: Element) => foreground(el) };
  return { state: "after-primary-screenshot", media, drift, overlay, foregroundObscured, coverage: { byForeground, byOtherOverlay }, unexpectedObscured,
    tapTargetFacts, links, linksCoveredByFront, summaries, overlapFacts };
};

// ---- (3) Keyboard witnesses: native keys only, run LAST (they change focus and may navigate) ----

/** Start from the focus the app itself set (`active`), or from the document entry. Each key must land
 *  on its `expect` selector; the last landing must be revealed (shown, painted, unclipped, hittable);
 *  `activate` then presses a key and waits for the app's own result. Nothing here calls focus() on a
 *  target or clicks it: a control only native keys cannot reach is blocked, never passed. */
export type KeyboardSpec = {
  name: string;
  start: "document" | { active: string };
  keys: { key: string; expect: string }[];
  activate?: { key: string; expect: { active?: string; hash?: string; inView?: string } };
};
type PageLike = {
  evaluate: <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>;
  keyboard: { press: (key: string) => Promise<void> };
  waitForFunction: <A>(fn: (arg: A) => boolean, arg: A, options: { timeout: number }) => Promise<unknown>;
};

const ACTIVE_NOW = (_: null) => {
  const h = (globalThis as unknown as { __auditHelpers: WitnessHelpers }).__auditHelpers;
  const el = document.activeElement;
  return !el || el === document.body ? "document" : h.describe(el);
};
/** After a key: wait (state, not time) until the focused element's box stops moving, then measure it. */
const LANDING = async (expect: string) => {
  const h = (globalThis as unknown as { __auditHelpers: WitnessHelpers }).__auditHelpers;
  const key = () => { const r = document.activeElement?.getBoundingClientRect(); return r ? `${r.left},${r.top},${r.width},${r.height}` : ""; };
  let last = key(), stable = 0, settled = false;
  for (const started = performance.now(); performance.now() - started < 2000;) {
    await new Promise(done => setTimeout(done, 16));
    const now = key();
    stable = now === last ? stable + 1 : 0;
    last = now;
    if (stable >= 3) { settled = true; break; }
  }
  const el = document.activeElement;
  if (!el || el === document.body) return { active: "document", matches: false, settled };
  const r = el.getBoundingClientRect();
  const opacity = h.opacityChain(el), clippedBy = h.clippedBy(el), reach = h.foreground(el);
  const inViewport = r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  return { active: h.describe(el), matches: el.matches(expect), settled, focusVisible: el.matches(":focus-visible"), hover: el.matches(":hover"),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }, inViewport, opacity, clippedBy, ...reach };
};
const EXPECTED = (e: { active?: string; hash?: string; inView?: string }) => {
  if (e.active && !document.activeElement?.matches(e.active)) return false;
  if (e.hash && location.hash !== e.hash) return false;
  if (e.inView) {
    const t = document.querySelector(e.inView);
    if (!t) return false;
    const r = t.getBoundingClientRect();
    if (!(r.bottom > 0 && r.top < innerHeight)) return false;
  }
  return true;
};

export async function runKeyboardWitness(page: PageLike, spec: KeyboardSpec) {
  type Landing = Awaited<ReturnType<typeof LANDING>>;
  const result: { name: string; state: string; start: string | null; landings: (Landing & { key: string })[]; activation: Record<string, unknown> | null;
    outcome: "pass" | "blocked" | "error"; reason: string | null } = { name: spec.name, state: "after-geometry-witnesses", start: null, landings: [], activation: null, outcome: "pass", reason: null };
  const blocked = (reason: string) => Object.assign(result, { outcome: "blocked" as const, reason });
  try {
    result.start = await page.evaluate(ACTIVE_NOW, null);
    if (spec.start === "document") {
      if (result.start !== "document") return blocked(`not at document entry: focus is on ${result.start}`);
    } else if (!(await page.evaluate(sel => !!document.activeElement?.matches(sel), spec.start.active))) {
      return blocked(`start not focused: expected ${spec.start.active}, focus is on ${result.start}`);
    }
    for (const step of spec.keys) {
      await page.keyboard.press(step.key);
      const landing = await page.evaluate(LANDING, step.expect);
      result.landings.push({ key: step.key, ...landing });
      if (!landing.matches) return blocked(`${step.key} landed on ${landing.active}, expected ${step.expect}`);
    }
    const last = result.landings.at(-1);
    if (last && "rect" in last) {
      const why = [
        !last.settled && "focus box still moving after 2 s",
        !last.inViewport && "outside the viewport",
        (last.rect!.w <= 2 || last.rect!.h <= 2) && `${last.rect!.w}x${last.rect!.h} box`,
        last.opacity! <= 0.05 && `opacity ${last.opacity}`,
        last.clippedBy && `clipped by ${last.clippedBy}`,
        last.reached === 0 && `no hit point reaches it (${last.by ?? "nothing"})`,
      ].filter(Boolean);
      if (why.length) return blocked(`not revealed: ${why.join("; ")}`);
    }
    if (spec.activate) {
      await page.keyboard.press(spec.activate.key);
      const ok = await page.waitForFunction(EXPECTED, spec.activate.expect, { timeout: 5_000 }).then(() => true, () => false);
      result.activation = { key: spec.activate.key, expect: spec.activate.expect, ok, active: await page.evaluate(ACTIVE_NOW, null), hash: await page.evaluate(() => location.hash, null) };
      if (!ok) return blocked(`${spec.activate.key} did not reach ${JSON.stringify(spec.activate.expect)}`);
    }
    return result;
  } catch (error) {
    return Object.assign(result, { outcome: "error" as const, reason: String(error instanceof Error ? error.message : error).split("\n")[0]!.slice(0, 300) });
  }
}

// ---- Summary counters for the witnesses (captures counted; raw summary keys are untouched) ----
type Item = Record<string, unknown>;
type Geometry = Partial<ReturnType<typeof GEOMETRY_WITNESS>> & { error?: string };
type KeyboardResult = Awaited<ReturnType<typeof runKeyboardWitness>>;
type TargetFact = ReturnType<typeof GEOMETRY_WITNESS>["tapTargetFacts"][number];
const frontTarget = (f: TargetFact) => f.layer !== "behind" && f.reached > 0 && f.opacity > 0.05 && f.clippedBy === null;
export function witnessSummary(report: Item[]) {
  const geo = (r: Item) => (r.witness ?? {}) as Geometry;
  const count = (test: (g: Geometry) => boolean) => report.filter(r => r.witness && !geo(r).error && test(geo(r))).length;
  const keyboard = report.flatMap(r => (r.keyboard as KeyboardResult[] | undefined) ?? []);
  return {
    primaryShots: report.filter(r => r.screenshot && !r.error).length,
    pending: report.filter(r => r.error === "pending").length,
    supplementaryImages: 0,
    witnessErrors: report.filter(r => !!geo(r).error).length,
    // Raw references that changed between CHECKS and the post-screenshot witness (the witness judged the live page).
    withRawDrift: count(g => !!g.drift && (g.drift.detached + g.drift.hidden + g.drift.moved + g.drift.added) > 0),
    withForegroundObscured: count(g => (g.foregroundObscured?.length ?? 0) > 0),
    withCoverageByOtherOverlay: count(g => (g.coverage?.byOtherOverlay.length ?? 0) > 0),
    withUnexpectedObscured: count(g => (g.unexpectedObscured?.length ?? 0) > 0),
    rawModalNotFront: count(g => !!g.overlay?.rawModal && g.overlay.rawModal !== g.overlay.front),
    // Every small target that is hittable, painted and unclipped and not behind the front overlay;
    // the second count leaves out only controls laid out inline in running text (still listed in tapTargetFacts).
    withFrontSmallTargets: count(g => (g.tapTargetFacts ?? []).some(f => frontTarget(f))),
    withFrontSmallTargetsOutsideText: count(g => (g.tapTargetFacts ?? []).some(f => frontTarget(f) && !f.inlineInText)),
    withLinksCoveredByFront: count(g => (g.linksCoveredByFront?.length ?? 0) > 0),
    withLinksMixed: count(g => (g.links ?? []).some(l => l.outcome === "mixed")),
    withLinksAllBlocked: count(g => (g.links ?? []).some(l => l.outcome === "all-blocked")),
    withLinkHitOnOtherLink: count(g => (g.links ?? []).some(l => l.fragments.some(f => "hitHref" in f))),
    withVisibleOverlaps: count(g => (g.overlapFacts ?? []).some(f => f.kind === "visible")),
    withClippedOverlaps: count(g => (g.overlapFacts ?? []).some(f => f.kind === "clipped")),
    withVisibleWrongTarget: count(g => (g.overlapFacts ?? []).some(f => f.kind === "visible" && f.wrongTarget)),
    // pass/blocked are measured outcomes (report-only); error means the measurement itself failed.
    keyboard: { pass: keyboard.filter(k => k.outcome === "pass").length, blocked: keyboard.filter(k => k.outcome === "blocked").length, error: keyboard.filter(k => k.outcome === "error").length },
  };
}

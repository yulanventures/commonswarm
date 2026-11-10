/**
 * Fixture regression matrix for the audit witnesses (audit-checks.ts), in a real browser at the
 * measurement boundary: each row loads a small page, runs CHECKS -> GEOMETRY_WITNESS -> keyboard
 * witness exactly as the runner does, and checks the reported classification. CI only
 * (RUN_BROWSER_TESTS=1); run-mobile-audit.ts imports this file so it runs first in the audit job.
 */
import assert from "node:assert/strict";
import { browserTest, launchPlaywrightChromium } from "../../site/tests/chrome.js";
import { CHECKS, GEOMETRY_WITNESS, runActivationWitness, runKeyboardWitness, witnessSummary, type ActivationSpec, type DeclaredOverlay, type KeyboardSpec } from "./audit-checks.js";
import { runHoverWitness, type HoverPage, type HoverResult, type HoverSpec } from "./hover-witness.js";

type Geometry = ReturnType<typeof GEOMETRY_WITNESS>;
type Keyboard = Awaited<ReturnType<typeof runKeyboardWitness>>;
type Activation = Awaited<ReturnType<typeof runActivationWitness>>;
type Page = Parameters<typeof runKeyboardWitness>[0] & Parameters<typeof runActivationWitness>[0] & HoverPage & {
  setContent(html: string): Promise<void>;
  goto(url: string): Promise<unknown>;
  route(url: string, handler: (route: { request(): { url(): string }; fulfill(response: { contentType: string; headers: Record<string, string>; body: string }): Promise<void> }) => Promise<void>): Promise<void>;
  focus(selector: string): Promise<void>;
  close(): Promise<void>;
};
type Row = { name: string; html: string; setup?: (page: Page) => Promise<void>; declared?: DeclaredOverlay[]; keyboard?: KeyboardSpec;
  /** Runs between CHECKS and GEOMETRY_WITNESS, where the runner takes the primary screenshot. */
  between?: (page: Page) => Promise<void>;
  /** Served from a fixture origin (real navigation) instead of setContent; other paths answer with a stub page. */
  served?: boolean;
  activation?: ActivationSpec[];
  hover?: HoverSpec;
  check: (result: { geometry: Geometry; keyboard?: Keyboard; activation?: Activation[]; hover?: HoverResult }) => void };

const page = (body: string, style = "") =>
  `<!doctype html><html><head><style>body{margin:0;font:16px/1.4 sans-serif} button{width:80px;height:44px}${style}</style></head><body>${body}</body></html>`;
const show = (json: unknown) => JSON.stringify(json);
const selectors = (rows: { selector: string }[]) => rows.map(r => r.selector);
/** Lay a transparent element over the first label fragment of `link` (fixture setup, not the witness). */
const coverFirstFragment = (link: string, tag: "div" | "a", href = "") => async (p: Page) => {
  await p.evaluate(({ link, tag, href }) => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(link)!);
    const r = range.getClientRects()[0]!;
    const cover = document.createElement(tag);
    if (href) (cover as HTMLAnchorElement).href = href;
    cover.id = "cover";
    Object.assign(cover.style, { position: "fixed", left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    document.body.append(cover);
  }, { link, tag, href });
};
const openModals = (...ids: string[]) => async (p: Page) => {
  await p.evaluate(order => { for (const id of order) (document.getElementById(id) as HTMLDialogElement).showModal(); }, ids);
};
const twoModals = (extraInB = "") => page(`<dialog id="a"><button id="a-ok">A ok</button></dialog><dialog id="b"><button id="b-ok">B ok</button>${extraInB}</dialog>`);
const legal = `<p style="font:14px/20px sans-serif;width:320px;margin:40px 8px">By continuing you agree to the
  <a id="terms" href="/terms" style="display:inline-flex;align-items:center;min-height:44px;margin-block:-12px">Terms</a> and
  <a id="privacy" href="/privacy" style="display:inline-flex;align-items:center;min-height:44px;margin-block:-12px">Privacy</a>.</p>`;
const wrapped = `<p id="p" style="width:20ch;font:16px/60px monospace;margin:0">aaaaaaaaaaaaaa <a id="wrap" href="/guide">bbbb cccccccccccc</a> dddd</p>`;
const revealPage = (style: string, backAttrs = "") => page(
  `<button id="grid">Grid</button><section><button id="back" class="sr"${backAttrs}>Back</button><h2 id="anchor" tabindex="-1">Title</h2><button id="next">Next</button></section>
   <script>document.getElementById("back").addEventListener("click", () => document.getElementById("grid").focus());</script>`, style);
const revealCss = ".sr:not(:focus){position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}";
const backSpec: KeyboardSpec = { name: "back", start: { active: "#anchor" }, keys: [{ key: "Shift+Tab", expect: "#back" }], activate: { key: "Enter", expect: { active: "#grid" } } };
const overlapPage = (top: number) => page(`<div id="scroller" style="position:relative;overflow:auto;width:300px;height:100px">
  <div style="position:relative;height:400px">
    <button id="x" style="position:absolute;left:10px;top:${top}px;width:100px">X</button>
    <button id="y" style="position:absolute;left:40px;top:${top + 10}px;width:100px">Y</button>
  </div></div>`);
const menuPage = (blocker: "absolute" | "fixed") => page(`<div style="position:relative">
  <button id="under" style="position:absolute;left:10px;top:10px">Under</button>
  <div id="menu" role="menu" style="position:absolute;left:0;top:0;width:160px;height:120px;background:#eee"><button id="item" role="menuitem" style="margin:60px 0 0 60px">Item</button></div>
  <button id="outside" style="position:absolute;left:250px;top:10px">Outside</button>
  <div id="blocker" style="position:${blocker};left:240px;top:0;width:120px;height:80px"></div></div>`);
const listPage = page(`<div style="position:relative"><button id="trigger" style="position:absolute;left:10px;top:10px">Open</button>
  <div id="list" style="position:absolute;left:0;top:0;width:200px;height:150px;background:#fff"><button id="opt" style="margin:80px 0 0 20px">Option</button></div></div>`);
const ORIGIN = "http://fixture.test";
const legalNote = page(`<p style="width:380px;font:14px/20px sans-serif;margin:40px 8px">Agree to the <a id="terms" href="/terms">Terms</a> and the <a id="privacy" href="/privacy">Privacy</a> notes.</p>`);
const legalSpecs: ActivationSpec[] = [
  { name: "terms", link: "#terms", expect: { path: "/terms" } },
  { name: "privacy", link: "#privacy", expect: { path: "/privacy" } },
];
/** A three-row feed; `extra` styles what hover or focus does. Row 1 is addressed, like the owner's message. */
const feed = (extra: string, short = false, after = "") => page(`<ul id="feed" style="list-style:none;margin:0;padding:0;width:360px">
  ${[0, 1, 2].map(i => `<li class="msg" data-i="${i}" style="position:relative;display:grid;grid-template-columns:auto 1fr">
    <span class="to" data-target-kind="${i === 1 ? "agent" : "everyone"}">→ Lead</span>
    <p class="body" style="margin:0">${short ? "Short note." : "A message long enough to wrap onto a second line in this narrow fixture column."}</p>
    <span class="extra">Thread</span><span class="tools" style="position:absolute;right:0;top:0">⋯</span><a href="#m${i}">link</a>
  </li>`).join("")}</ul>${after}`, // Row padding is a stylesheet rule, not inline, so a fixture's :hover rule can change it.
  `.msg{padding:4px 8px} .to{display:none} .extra{display:none} .tools{display:none} ${extra}`);
/** Ten keyed rows (each with a link), in a 200px scroller or in the page itself. `onHover` runs once, on the first pointer
 *  entry into row s5; `onFocus` once, on the first focus inside it; `onLoad` at load. `fresh()` rebuilds the list from
 *  new markup, so rebuilt rows carry no audit marker. */
const keyedList = (onHover: string, options: { onLoad?: string; onFocus?: string; inPage?: boolean } = {}) => {
  const rows = Array.from({ length: 10 }, (_, i) => `<li class="msg" data-signal-id="s${i}" style="line-height:40px;margin:0">Row ${i} <a href="#s${i}">open</a></li>`).join("");
  return page(`${options.inPage ? '<div style="height:600px"></div>' : ""}
  <div id="scroller" style="${options.inPage ? "" : "height:200px;overflow:auto;"}width:300px">
  <ul id="feed" style="list-style:none;margin:0;padding:0">${rows}</ul></div>${options.inPage ? '<div style="height:1200px"></div>' : ""}
  <script>const feed = document.getElementById("feed"); const scroller = document.getElementById("scroller");
  const fresh = () => { feed.innerHTML = ${JSON.stringify(rows)}; };
  ${options.onLoad ?? ""}
  let fired = false; scroller.addEventListener("mouseover", (event) => {
    const row = event.target.closest && event.target.closest('.msg[data-signal-id="s5"]');
    if (!row || fired) return; fired = true;
    ${onHover}
  });
  let focused = false; scroller.addEventListener("focusin", (event) => {
    const row = event.target.closest && event.target.closest('.msg[data-signal-id="s5"]');
    if (!row || focused) return; focused = true;
    ${options.onFocus ?? ""}
  });</script>`);
};
const keyedSpec: HoverSpec = { name: "keyed", rows: "#feed > .msg", prefer: '[data-signal-id="s5"]', require: ['[data-signal-id="s5"]'], max: 1 };
const feedSpec: HoverSpec = { name: "feed", rows: "#feed > .msg", prefer: '.msg:has([data-target-kind="agent"])', require: ['.msg[data-i="1"]'], focus: true };
const rowOf = (h: HoverResult | undefined, mode: "hover" | "focus") => h?.rows.find(r => r.preferred && r.mode === mode);
const pair = (g: Geometry) => g.overlapFacts.find(f => f.a === "button#x" && f.b === "button#y");

const ROWS: Row[] = [
  // Foreground modal: paint (opening) order, not DOM order, decides the front.
  { name: "modals opened in DOM order: the later one is in front", html: twoModals(), setup: openModals("a", "b"), check: ({ geometry: g }) => {
    assert.equal(g.overlay.front, "dialog#b", show(g.overlay));
    assert.equal(g.overlay.rawModal, "dialog#a", "the raw check still names the first DOM modal");
    assert.ok(g.overlay.frontControls.inView > 0 && g.overlay.frontControls.reached === g.overlay.frontControls.inView, show(g.overlay.frontControls));
    assert.ok(selectors(g.coverage.byForeground).includes("button#a-ok"), show(g.coverage));
    assert.deepEqual(g.foregroundObscured, []);
    assert.deepEqual(g.unexpectedObscured, []);
  } },
  { name: "modals opened against DOM order: the earlier one is in front", html: twoModals(), setup: openModals("b", "a"), check: ({ geometry: g }) => {
    assert.equal(g.overlay.front, "dialog#a", show(g.overlay));
    assert.ok(selectors(g.coverage.byForeground).includes("button#b-ok"), show(g.coverage));
    assert.deepEqual(g.foregroundObscured, []);
  } },
  { name: "a pointer-blocking element over a front-modal button is a foreground finding",
    html: twoModals(`<div id="blocker" style="position:absolute;inset:0"></div>`), setup: openModals("a", "b"), check: ({ geometry: g }) => {
      assert.equal(g.overlay.front, "dialog#b");
      assert.deepEqual(g.foregroundObscured, [{ selector: "button#b-ok", by: "div#blocker" }]);
    } },
  // Nonmodal overlay: coverage is expected only inside its painted area.
  { name: "a menu covers inside its area; a blocked control outside it stays unexpected", html: menuPage("absolute"), check: ({ geometry: g }) => {
    assert.equal(g.overlay.front, "div#menu", show(g.overlay));
    assert.deepEqual(selectors(g.coverage.byForeground), ["button#under"]);
    assert.deepEqual(g.unexpectedObscured, [{ selector: "button#outside", by: "div#blocker" }]);
  } },
  { name: "a FIXED blocker over a visible control outside the menu still stays unexpected", html: menuPage("fixed"), check: ({ geometry: g }) => {
    assert.equal(g.overlay.front, "div#menu", show(g.overlay));
    assert.deepEqual(selectors(g.unexpectedObscured), ["button#outside"], show(g.unexpectedObscured));
    assert.equal(g.unexpectedObscured[0]?.by, "div#blocker");
  } },
  // Small targets: text beside a control is context, not an exemption.
  { name: "a small block button beside paragraph text still counts as a front small target",
    html: page(`<p>Choose <button id="open" style="display:block;width:80px;height:20px">Open</button></p>`), check: ({ geometry: g }) => {
      const fact = g.tapTargetFacts.find(f => f.selector === "button#open");
      assert.ok(fact?.inText, `fixture: parent text must sit beside the button; ${show(g.tapTargetFacts)}`);
      assert.equal(witnessSummary([{ screenshot: "s.png", witness: g }]).withFrontSmallTargets, 1, show(fact));
    } },
  // Wrapped inline link: fragments are judged one by one.
  { name: "a wrapped link whose union centre misses still has every fragment reachable", html: page(wrapped), check: ({ geometry: g }) => {
    const link = g.links.find(l => l.selector === "a#wrap");
    assert.ok(link, `fixture: the union centre must miss so the fragments are tested; links=${show(g.links)}`);
    assert.equal(link.unionHit, "p#p");
    assert.equal(link.outcome, "all-hit", show(link));
    assert.ok(link.fragments.filter(f => f.shown).length >= 2, show(link.fragments));
  } },
  { name: "covering one fragment of a wrapped link makes it mixed, not a pass", html: page(wrapped), setup: coverFirstFragment("#wrap", "div"), check: ({ geometry: g }) => {
    assert.equal(g.links.find(l => l.selector === "a#wrap")?.outcome, "mixed", show(g.links));
  } },
  { name: "an inline-flex legal link whose label sits under another link is blocked, with the other destination named",
    html: page(legal), setup: coverFirstFragment("#privacy", "a", "/terms"), check: ({ geometry: g }) => {
      const link = g.links.find(l => l.selector === "a#privacy");
      assert.ok(link, show(g.links));
      assert.equal(link.display, "inline-flex");
      assert.equal(link.outcome, "all-blocked", show(link));
      assert.ok(link.fragments.some(f => "hitHref" in f && f.hitHref?.endsWith("/terms")), show(link.fragments));
    } },
  // Links behind the front overlay: classified by who receives each fragment's hit.
  { name: "a link under a modal backdrop is covered by the front, not blocked, and keeps its fragment records",
    html: page(`<p style="margin:20px"><a id="bg" href="/bg">Background link text</a></p><dialog id="m"><button id="ok">OK</button></dialog>`), setup: openModals("m"),
    check: ({ geometry: g }) => {
      assert.ok(!g.links.some(l => l.selector === "a#bg"), `the covered link must not be a blocked finding: ${show(g.links)}`);
      const covered = g.linksCoveredByFront.find(l => l.selector === "a#bg");
      assert.ok(covered && covered.fragments.length > 0 && covered.fragments.every(f => f.coveredByFront), show(g.linksCoveredByFront));
      assert.equal(witnessSummary([{ screenshot: "s.png", witness: g }]).withLinksAllBlocked, 0);
    } },
  { name: "a wrong-link collision outside a small menu's painted area stays reportable",
    html: page(`<div id="menu" role="menu" style="position:absolute;left:0;top:0;width:140px;height:100px;background:#eee"><button id="mi" role="menuitem">Item</button></div>
      <p style="position:absolute;left:200px;top:200px;margin:0;font:14px/20px sans-serif"><a id="t" href="/terms">Terms</a></p>`),
    setup: coverFirstFragment("#t", "a", "/privacy"), check: ({ geometry: g }) => {
      assert.equal(g.overlay.front, "div#menu", show(g.overlay));
      const link = g.links.find(l => l.selector === "a#t");
      assert.ok(link, `the collision must remain a finding: ${show({ links: g.links, covered: g.linksCoveredByFront })}`);
      assert.equal(link.layer, "behind");
      assert.equal(link.outcome, "all-blocked", show(link));
      assert.ok(link.fragments.some(f => "hitHref" in f && f.hitHref?.endsWith("/privacy")), show(link.fragments));
    } },
  // Declared overlay roots (a picker list with no menu role).
  { name: "a declared list root is the front overlay; the control under it is front coverage", html: listPage, declared: ["#list"], check: ({ geometry: g }) => {
    assert.equal(g.overlay.front, "div#list", show(g.overlay));
    assert.deepEqual(selectors(g.coverage.byForeground), ["button#trigger"]);
    assert.deepEqual(g.unexpectedObscured, []);
    assert.deepEqual(g.foregroundObscured, []);
  } },
  { name: "a declared root whose media query does not match is not an overlay", html: listPage, declared: [{ selector: "#list", media: "(width > 9999px)" }],
    check: ({ geometry: g }) => {
      assert.equal(g.overlay.front, null, show(g.overlay));
      assert.deepEqual(g.unexpectedObscured, [{ selector: "button#trigger", by: "div#list" }]);
    } },
  { name: "the same list undeclared leaves the covered control unexpected", html: listPage, check: ({ geometry: g }) => {
    assert.equal(g.overlay.front, null, show(g.overlay));
    assert.deepEqual(g.unexpectedObscured, [{ selector: "button#trigger", by: "div#list" }]);
  } },
  // Drift between CHECKS and the post-screenshot witness.
  { name: "content replaced after CHECKS: the witness judges the live dialog and reports stale raw references",
    html: page(`<dialog id="d"><div id="body"><button id="keep">Keep</button> <button id="old1" style="width:30px;height:30px">1</button> <button id="old2">Old</button></div></dialog>`),
    setup: openModals("d"),
    between: async p => {
      await p.evaluate(() => {
        const body = document.getElementById("body")!;
        const spacer = document.createElement("div");
        spacer.id = "spacer"; spacer.style.height = "120px";
        body.prepend(spacer);
        for (const id of ["old1", "old2"]) document.getElementById(id)!.remove();
        for (const id of ["new1", "new2"]) { const b = document.createElement("button"); b.id = id; b.textContent = id; body.append(b); }
      }, undefined);
    },
    check: ({ geometry: g }) => {
      assert.equal(g.overlay.front, "dialog#d", show(g.overlay));
      assert.deepEqual(g.overlay.frontControls, { inView: 3, reached: 3 }, "keep, new1 and new2, judged where they are now");
      assert.deepEqual(g.foregroundObscured, [], show(g.foregroundObscured));
      assert.equal(g.drift.detached, 2, show(g.drift));
      assert.ok(g.drift.moved >= 1 && g.drift.added === 2, show(g.drift));
      assert.equal(g.tapTargetFacts.find(f => f.selector === "button#old1")?.stale, "detached", show(g.tapTargetFacts));
    } },
  // Activation: a native tap on the visible label, then the page actually reached.
  { name: "tapping each legal link's label opens its own page", html: legalNote, served: true, activation: legalSpecs, check: ({ activation: a }) => {
    assert.deepEqual(a?.map(r => [r.name, r.outcome, r.landed?.path, r.returned]), [["terms", "pass", "/terms", true], ["privacy", "pass", "/privacy", true]], show(a));
  } },
  { name: "a Privacy link over the Terms label: tapping Terms opens /privacy and is blocked", html: legalNote, served: true, activation: legalSpecs,
    setup: coverFirstFragment("#terms", "a", "/privacy"), check: ({ activation: a }) => {
      const terms = a?.[0];
      assert.equal(terms?.outcome, "blocked", show(terms));
      assert.equal(terms.landed?.path, "/privacy");
      assert.equal(terms.target?.hitHref?.endsWith("/privacy"), true, show(terms.target));
      assert.equal(a?.[1]?.outcome, "pass", show(a?.[1]));
    } },
  // Overlaps: an open menu over a control behind it is front coverage, not a wrong-target collision.
  { name: "an open menu overlapping a control behind it is front coverage, not a wrong target", html: page(`<div style="position:relative">
      <button id="under" style="position:absolute;left:10px;top:10px;width:100px">Under</button>
      <div id="menu" role="menu" style="position:absolute;left:40px;top:20px;width:160px;height:80px;background:#eee"><button id="item" role="menuitem" style="width:100px">Item</button></div></div>`),
    check: ({ geometry: g }) => {
      assert.equal(g.overlay.front, "div#menu", show(g.overlay));
      const f = g.overlapFacts.find(o => o.a === "button#under" && o.b === "button#item");
      assert.ok(f, `the raw overlap must still be recorded: ${show(g.overlapFacts)}`);
      assert.equal(f.kind, "visible");
      assert.equal(f.frontCovered, true, show(f.points));
      assert.equal(f.wrongTarget, false, show(f.points));
    } },
  // Viewport edge: a centre whose hit test returns nothing is recorded as such, not as obscured.
  { name: "a centre in the viewport edge's last fraction is recorded in noHitAtCentre, not as obscured",
    html: page(`<button id="edge" style="position:fixed;left:0;top:0;width:40px;height:43px">E</button>`),
    setup: async p => {
      // Find a point inside the viewport that this engine's hit test still resolves to nothing, and centre the control there.
      const y = await p.evaluate(() => {
        for (let k = 1; k < 20; k += 1) {
          const candidate = innerHeight - 1 + k / 20;
          if (document.elementFromPoint(20, candidate) === null) {
            document.getElementById("edge")!.style.top = `${candidate - 21.5}px`;
            return candidate;
          }
        }
        return null;
      }, undefined);
      assert.ok(y !== null, "fixture: no point inside the bottom edge hits nothing in this engine, so the case cannot be exercised");
    },
    check: ({ geometry: g }) => {
      const edge = g.noHitAtCentre.find(n => n.selector === "button#edge");
      assert.ok(edge && edge.y > 599 && edge.y < 600 && edge.x === 20, show(g.noHitAtCentre));
      assert.ok(!selectors(g.unexpectedObscured).includes("button#edge"), show(g.unexpectedObscured));
    } },
  // Keyboard reveal: native keys only.
  { name: "Shift+Tab reveals a clip-on-blur control and Enter returns focus", html: revealPage(revealCss), setup: p => p.focus("#anchor"), keyboard: backSpec,
    check: ({ keyboard: k }) => {
      assert.equal(k?.outcome, "pass", show(k));
      const landing = k.landings[0];
      assert.ok(landing && "clippedBy" in landing && landing.clippedBy === null, show(landing));
      assert.equal(k.activation?.ok, true);
    } },
  { name: "a reveal broken by CSS is blocked as clipped", html: revealPage(".sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}"),
    setup: p => p.focus("#anchor"), keyboard: backSpec, check: ({ keyboard: k }) => {
      assert.equal(k?.outcome, "blocked", show(k));
      assert.match(k.reason ?? "", /not revealed: .*clipped by button#back/u);
    } },
  { name: "a control only script focus could reach is blocked, never passed", html: revealPage(revealCss, ' tabindex="-1"'),
    setup: p => p.focus("#anchor"), keyboard: backSpec, check: ({ keyboard: k }) => {
      assert.equal(k?.outcome, "blocked", show(k));
      assert.match(k.reason ?? "", /Shift\+Tab landed on button#grid/u);
    } },
  // Overlap: clipped shared area is separate from a visible collision.
  { name: "an overlap outside a scroller's client area is clipped", html: overlapPage(200), check: ({ geometry: g }) => {
    const f = pair(g);
    assert.ok(f, `the raw overlap must still be recorded: ${show(g.overlapFacts)}`);
    assert.equal(f.kind, "clipped", show(f));
    assert.equal(f.visibleArea, 0);
    assert.equal(f.wrongTarget, false);
  } },
  // Hover stability (hover-witness.ts): anything a hover or focus moves or resizes is a shift; colour and opacity are not.
  { name: "a recipient revealed in a column on hover moves a short body sideways: shifted (the owner's report)",
    html: feed(".msg:hover .to{display:inline}", true), hover: feedSpec, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "shifted", show(h));
      const r = rowOf(h, "hover")!;
      assert.equal(r.early?.hoverMatched, true, show(r));
      assert.ok(r.early!.shifts.some(s => s.label.startsWith("p.body") && s.dx > 0), show(r.early));
  } },
  { name: "the same recipient revealed by opacity alone is stable", html: feed(".to{display:inline;opacity:0} .msg:hover .to{opacity:1}", true),
    hover: feedSpec, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "stable", show(h));
      assert.equal(rowOf(h, "hover")?.early?.hoverMatched, true);
  } },
  { name: "an absolutely placed toolbar appearing on hover is stable", html: feed(".msg:hover .tools{display:block}"), hover: feedSpec, check: ({ hover: h }) => {
    assert.equal(h?.outcome, "stable", show(h));
  } },
  { name: "a line added on hover pushes the next row down: the other row is a shift", html: feed(".msg:hover .extra{display:block}"), hover: feedSpec, check: ({ hover: h }) => {
    assert.equal(h?.outcome, "shifted", show(h));
    assert.ok(rowOf(h, "hover")!.early!.shifts.some(s => s.who === "other-row" && s.dy > 0), show(rowOf(h, "hover")));
  } },
  { name: "a transitioned padding change is caught after the transition", html: feed(".msg{transition:padding-left .3s linear} .msg:hover{padding-left:40px}"),
    hover: feedSpec, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "shifted", show(h));
      assert.ok((rowOf(h, "hover")!.late?.shifted ?? 0) > 0, show(rowOf(h, "hover")));
  } },
  { name: "bold text on hover changes the text box: shifted", html: feed(".msg:hover .body{font-weight:700}"), hover: feedSpec, check: ({ hover: h }) => {
    assert.equal(h?.outcome, "shifted", show(h));
  } },
  { name: "a recipient revealed by focus-within is shifted in focus mode only", html: feed(".msg:focus-within .to{display:inline}", true), hover: feedSpec, check: ({ hover: h }) => {
    assert.equal(h?.outcome, "shifted", show(h));
    assert.equal(rowOf(h, "hover")?.outcome, "stable", show(h));
    assert.equal(rowOf(h, "focus")?.outcome, "shifted", show(h));
    assert.equal(rowOf(h, "focus")?.late?.focusWithin, true);
  } },
  { name: "with no addressed row to measure, the hover witness is an error, never a pass", html: feed(""),
    hover: { ...feedSpec, require: ['.msg:has([data-target-kind="person"])'] }, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "error", show(h));
  } },
  { name: "a required row the pointer cannot reach is an error, never a pass", html: feed("", false, '<div id="cover" style="position:fixed;inset:0;z-index:9"></div>'),
    hover: { ...feedSpec, focus: false }, check: ({ hover: h }) => {
      assert.equal(rowOf(h, "hover")?.outcome, "skipped", show(h));
      assert.equal(h?.outcome, "error", show(h));
      assert.match(h!.reason ?? "", /required rows not measured/u);
  } },
  { name: "rows that cover the whole viewport leave no neutral rest: an error, never a pass",
    html: page(`<div id="feed">${[0, 1].map(i => `<div class="msg" data-i="${i}" style="height:50vh">Row ${i}</div>`).join("")}</div>`),
    hover: { name: "feed", rows: "#feed > .msg", require: ['.msg[data-i="0"]'] }, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "error", show(h));
      assert.match(h!.rows[0]!.reason ?? "", /no point outside the rows/u, show(h));
  } },
  // The app's list lifecycle: identity is by key and positions are scroll-content coordinates, so a benign rebuild
  // or scroll is recorded but never a shift, and neither can turn a hover shift into a pass.
  { name: "a same-key rebuild with identical layout during hover is stable, and the rebuild is recorded",
    html: keyedList("feed.innerHTML = feed.innerHTML;"), hover: keyedSpec, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "stable", show(h));
      const r = h!.rows[0]!;
      assert.ok((r.early?.rebuilt ?? 0) + (r.late?.rebuilt ?? 0) > 0, show(r));
  } },
  { name: "a rebuild caused by hover that makes the row taller is a shift, not a re-measure",
    html: keyedList("feed.innerHTML = feed.innerHTML.replace('Row 5 ', 'Row 5<br>a second line ');"), hover: keyedSpec, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "shifted", show(h));
      assert.ok((h!.rows[0]!.early?.rebuilt ?? 0) + (h!.rows[0]!.late?.rebuilt ?? 0) > 0, show(h));
  } },
  { name: "a one-time hover mutation is a shift even though it never repeats",
    html: keyedList("row.insertAdjacentHTML('afterbegin', '<div>added once</div>');"), hover: keyedSpec, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "shifted", show(h));
  } },
  { name: "hover growth above the row absorbed by scroll anchoring is still a shift",
    html: keyedList("feed.firstElementChild.style.height = '70px';"), hover: keyedSpec, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "shifted", show(h));
  } },
  { name: "the list scrolling by itself during hover is recorded, not a shift",
    html: keyedList("scroller.scrollTop -= 10;"), hover: keyedSpec, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "stable", show(h));
      const r = h!.rows[0]!;
      assert.ok([r.early, r.late].some(c => c && c.scrolled.y !== 0), show(r));
  } },
  { name: "a list rebuilt by a pending read before rest is measured on the live rows, and a later required row is covered",
    html: keyedList("", { onLoad: "globalThis.__auditPendingFetches = 1; setTimeout(() => { fresh(); globalThis.__auditPendingFetches = 0; globalThis.__auditLastFetchDoneAt = performance.now(); }, 300);" }),
    hover: { name: "keyed", rows: "#feed > .msg", require: ['[data-signal-id="s7"]'], max: 2 }, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "stable", show(h));
      assert.deepEqual(h!.coverage, [{ selector: '[data-signal-id="s7"]', mode: "hover", measured: true }], show(h));
  } },
  { name: "focus lost to a rebuild during the measurement is an error, never a stable pass",
    html: keyedList("", { onFocus: "fresh();" }), hover: { ...keyedSpec, focus: true, focusTarget: "a" }, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "error", show(h));
      assert.match(h!.rows.find(r => r.mode === "focus")?.reason ?? "", /focus was lost/u, show(h));
  } },
  { name: "the page itself scrolling during hover is counted once and recorded, not a shift",
    html: keyedList("window.scrollBy(0, -10);", { inPage: true }), hover: keyedSpec, check: ({ hover: h }) => {
      assert.equal(h?.outcome, "stable", show(h));
      assert.ok([h!.rows[0]!.early, h!.rows[0]!.late].some(c => c && c.scrolled.y === -10), show(h));
  } },
  { name: "a row that moves when the pointer leaves is a shift, though hovering it was stable",
    html: feed(".left .body{padding-left:12px}", false,
      "<script>for (const m of document.querySelectorAll('.msg')) m.addEventListener('mouseleave', () => m.classList.add('left'));</script>"),
    hover: { ...feedSpec, focus: false }, check: ({ hover: h }) => {
      const r = rowOf(h, "hover")!;
      assert.equal(r.early?.shifted, 0, show(r));
      assert.equal(r.late?.shifted, 0, show(r));
      assert.ok((r.restored?.shifted ?? 0) > 0, show(r));
      assert.equal(r.outcome, "shifted");
      assert.equal(h?.outcome, "shifted");
  } },
  { name: "a body that re-wraps under a fixed header, with every element box unchanged, is a shift",
    html: page(`<ul id="feed" style="list-style:none;margin:0;padding:0">${[0, 1].map(i => `<li class="msg" data-i="${i}" style="padding:4px 8px">
      <strong class="author">Agent</strong><p class="body" style="margin:0;width:30ch;font:16px/20px monospace">aaaa bbbb cccc dddd eeee ffff gggg hhhh</p></li>`).join("")}</ul>`,
      ".msg:hover .body{text-indent:2ch}"),
    hover: { name: "feed", rows: "#feed > .msg", require: ['.msg[data-i="0"]'] }, check: ({ hover: h }) => {
      const r = h!.rows.find(row => row.index === 0)!;
      assert.equal(r.outcome, "shifted", show(r));
      const shifts = [...(r.early?.shifts ?? []), ...(r.late?.shifts ?? [])];
      assert.ok(shifts.some(s => s.who === "text" && s.label === "text in p.body"), show(shifts));
      assert.ok(!shifts.some(s => s.who !== "text"), `only text fragments move: ${show(shifts)}`);
  } },
  { name: "the same overlap in view is a visible wrong-target finding", html: overlapPage(20), check: ({ geometry: g }) => {
    const f = pair(g);
    assert.ok(f, show(g.overlapFacts));
    assert.equal(f.kind, "visible", show(f));
    assert.equal(f.wrongTarget, true, show(f.points));
  } },
];

/** The matrix's result, so the long audit run can refuse to start after a failed row. */
export const matrixResult = { done: false, failed: [] as string[] };

browserTest("audit witnesses: fixture regression matrix", { timeout: 5 * 60_000 }, async (t) => {
  const playwrightModule = "playwright";
  const { chromium } = await import(playwrightModule) as { chromium: Parameters<typeof launchPlaywrightChromium<any>>[0] };
  const browser = await launchPlaywrightChromium<any>(chromium);
  try {
    // hasTouch, as in every audit context: the activation rows tap with the touchscreen.
    const context = await browser.newContext({ viewport: { width: 400, height: 600 }, deviceScaleFactor: 1, hasTouch: true });
    // tsx (esbuild keepNames) wraps nested functions in __name(); the page needs a no-op, as in the runner.
    await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    for (const row of ROWS) {
      await t.test(row.name, async () => { try { await runRow(row); } catch (error) { matrixResult.failed.push(row.name); throw error; } });
    }
    matrixResult.done = true;
    async function runRow(row: Row) {
      {
        const p = await context.newPage() as Page;
        try {
          if (row.served) {
            await p.route(`${ORIGIN}/**`, async route => {
              const path = new URL(route.request().url()).pathname;
              // no-store keeps pages out of the back/forward cache, so going back loads a fresh document, as in the app.
              await route.fulfill({ contentType: "text/html", headers: { "cache-control": "no-store" },
                body: path === "/" ? row.html : `<!doctype html><title>${path}</title><p>${path}</p>` });
            });
            await p.goto(`${ORIGIN}/`);
          } else await p.setContent(row.html);
          await row.setup?.(p);
          await p.evaluate(CHECKS, undefined);
          await row.between?.(p);
          const geometry = await p.evaluate(GEOMETRY_WITNESS, row.declared ?? []);
          const keyboard = row.keyboard ? await runKeyboardWitness(p, row.keyboard) : undefined;
          const activation: Activation[] = [];
          for (const spec of row.activation ?? []) activation.push(await runActivationWitness(p, spec));
          const hover = row.hover ? await runHoverWitness(p, row.hover) : undefined;
          row.check({ geometry, keyboard, activation, hover });
        } finally { await p.close(); }
      }
    }
  } finally { await browser.close(); }
});

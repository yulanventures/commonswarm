/**
 * Fixture regression matrix for the audit witnesses (audit-checks.ts), in a real browser at the
 * measurement boundary: each row loads a small page, runs CHECKS -> GEOMETRY_WITNESS -> keyboard
 * witness exactly as the runner does, and checks the reported classification. CI only
 * (RUN_BROWSER_TESTS=1); run-mobile-audit.ts imports this file so it runs first in the audit job.
 */
import assert from "node:assert/strict";
import { browserTest, launchPlaywrightChromium } from "../../site/tests/chrome.js";
import { CHECKS, GEOMETRY_WITNESS, runKeyboardWitness, witnessSummary, type KeyboardSpec } from "./audit-checks.js";

type Geometry = ReturnType<typeof GEOMETRY_WITNESS>;
type Keyboard = Awaited<ReturnType<typeof runKeyboardWitness>>;
type Page = Parameters<typeof runKeyboardWitness>[0] & {
  setContent(html: string): Promise<void>;
  focus(selector: string): Promise<void>;
  close(): Promise<void>;
};
type Row = { name: string; html: string; setup?: (page: Page) => Promise<void>; declared?: string[]; keyboard?: KeyboardSpec;
  check: (result: { geometry: Geometry; keyboard?: Keyboard }) => void };

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
  { name: "the same overlap in view is a visible wrong-target finding", html: overlapPage(20), check: ({ geometry: g }) => {
    const f = pair(g);
    assert.ok(f, show(g.overlapFacts));
    assert.equal(f.kind, "visible", show(f));
    assert.equal(f.wrongTarget, true, show(f.points));
  } },
];

browserTest("audit witnesses: fixture regression matrix", { timeout: 5 * 60_000 }, async (t) => {
  const playwrightModule = "playwright";
  const { chromium } = await import(playwrightModule) as { chromium: Parameters<typeof launchPlaywrightChromium<any>>[0] };
  const browser = await launchPlaywrightChromium<any>(chromium);
  try {
    const context = await browser.newContext({ viewport: { width: 400, height: 600 }, deviceScaleFactor: 1 });
    // tsx (esbuild keepNames) wraps nested functions in __name(); the page needs a no-op, as in the runner.
    await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
    for (const row of ROWS) {
      await t.test(row.name, async () => {
        const p = await context.newPage() as Page;
        try {
          await p.setContent(row.html);
          await row.setup?.(p);
          await p.evaluate(CHECKS, undefined);
          const geometry = await p.evaluate(GEOMETRY_WITNESS, row.declared ?? []);
          const keyboard = row.keyboard ? await runKeyboardWitness(p, row.keyboard) : undefined;
          row.check({ geometry, keyboard });
        } finally { await p.close(); }
      });
    }
  } finally { await browser.close(); }
});

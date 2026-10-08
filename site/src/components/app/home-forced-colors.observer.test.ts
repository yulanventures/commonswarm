/** Reached by `npm --prefix site test` and `test:ci` through the recursive component-observer glob. Pure: reads CSS only. */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/*
 * Forced colours (Windows High Contrast) drop box-shadow and background fills. The home controls draw
 * their keyboard focus with a box-shadow ring and set `outline: none`, at a higher specificity than
 * global.css's forced-colors `:focus-visible` outline, so in forced colours a focused control showed
 * nothing (code review, release 7). The fix is one forced-colors outline in global.css that wins over
 * every such rule (`!important`), plus a forced-colors outline on each wrapper that shows the focus of
 * a hidden input (the wrapper is not itself focused, so no `:focus-visible` rule reaches it).
 * This file enumerates every home focus rule and reconciles it against that cover.
 */
const siteRoot = join(import.meta.dirname, "..", "..", "..");
const homeDir = join(siteRoot, "src/styles/home");
const read = (path: string): string => readFileSync(join(siteRoot, path), "utf8");

type Rule = { file: string; selector: string; body: string; forced: boolean };

/** Flat rules with whether they sit inside `@media (forced-colors: active)`. Comments removed first. */
function rules(file: string, css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const walk = (start: number, end: number, forced: boolean): void => {
    let cursor = start;
    while (cursor < end) {
      const open = text.indexOf("{", cursor);
      if (open === -1 || open >= end) return;
      const head = text.slice(cursor, open).trim();
      let depth = 1, close = open + 1;
      for (; close < end && depth > 0; close += 1) { if (text[close] === "{") depth += 1; else if (text[close] === "}") depth -= 1; }
      const inner = [open + 1, close - 1] as const;
      if (head.startsWith("@media")) walk(inner[0], inner[1], forced || /forced-colors:\s*active/.test(head));
      else if (head.startsWith("@")) walk(inner[0], inner[1], forced);
      else for (const selector of splitSelectors(head)) out.push({ file, selector, body: text.slice(inner[0], inner[1]), forced });
      cursor = close;
    }
  };
  walk(0, text.length, false);
  return out;
}

/** Split a selector list on top-level commas (not the ones inside :is(), :has(), :not()). */
function splitSelectors(list: string): string[] {
  const parts: string[] = []; let depth = 0, from = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === "(") depth += 1; else if (list[i] === ")") depth -= 1;
    else if (list[i] === "," && depth === 0) { parts.push(list.slice(from, i)); from = i + 1; }
  }
  parts.push(list.slice(from));
  return parts.map((part) => part.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** The last compound selector (the element the rule styles), split at top-level combinators. */
function subject(selector: string): { compound: string; before: string } {
  let depth = 0, cut = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i]!;
    if (char === "(") depth += 1; else if (char === ")") depth -= 1;
    else if (depth === 0 && (char === " " || char === ">" || char === "+" || char === "~")) cut = i + 1;
  }
  return { compound: selector.slice(cut).trim(), before: selector.slice(0, cut).trim() };
}

const homeFiles = readdirSync(homeDir).filter((name) => name.endsWith(".css")).sort();
const dashboard = read("src/components/app/LiveDashboard.astro");
const dashboardStyles = [...dashboard.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]!).join("\n");
const homeRules: Rule[] = [
  ...homeFiles.flatMap((name) => rules(`styles/home/${name}`, readFileSync(join(homeDir, name), "utf8"))),
  ...rules("LiveDashboard.astro <style>", dashboardStyles),
];
const focusRules = homeRules.filter((rule) => !rule.forced && /:focus(?:-visible)?\b/.test(rule.selector));
const suppresses = (rule: Rule): boolean => /(?:^|;)\s*outline\s*:\s*(?:none|0)\b/.test(rule.body);
const drawsRing = (rule: Rule): boolean => /box-shadow\s*:[^;]*var\(--focus-ring\)/.test(rule.body);
const forcedOutline = (rule: Rule): boolean => rule.forced && /outline\s*:\s*\d+px\s+solid\s+Highlight/.test(rule.body);

test("global.css gives every focused control a forced-colors outline that outranks component rules", () => {
  const globalRules = rules("global.css", read("src/styles/global.css"));
  const cover = globalRules.filter((rule) => rule.forced && rule.selector.startsWith(":focus-visible") && /outline\s*:\s*3px solid Highlight\s*!important/.test(rule.body));
  assert.equal(cover.length, 1, `one !important forced-colors focus outline in global.css: ${JSON.stringify(cover)}`);
  assert.match(cover[0]!.body, /outline-offset\s*:\s*2px\s*!important/);
  /* Its only exclusion is a heading that is a programmatic route target. Anything wider would let a control lose its ring. */
  assert.equal(cover[0]!.selector, ':focus-visible:not(:is(h1, h2, h3, h4, h5, h6)[tabindex="-1"])');
  /* Base.astro loads global.css on every page, including /app and /invite. */
  assert.match(read("src/layouts/Base.astro"), /import "\.\.\/styles\/global\.css"/);
  for (const page of ["src/pages/app.astro", "src/pages/invite.astro"]) assert.match(read(page), /Base/, page);
});

test("every home focus rule that suppresses the outline is covered in forced colours", () => {
  const suppressing = focusRules.filter(suppresses);
  /* Positive control: the two controls the review measured are in the enumerated set. A parser that found
     nothing would make every check below pass. */
  for (const known of ["section.pd-page[data-people-page] :is(button, a, select, input):focus-visible", ".hm-picker .hm-assign-chip.hm-assign-chip:focus-visible"]) {
    assert.ok(suppressing.some((rule) => rule.selector === known), `enumeration missed ${known}`);
  }
  // A sanity floor only; the reconciliation below is the check.
  assert.ok(suppressing.length >= 40, `expected the full set of home focus rules, found ${suppressing.length}`);
  const uncovered: string[] = [];
  for (const rule of suppressing) {
    /* An !important outline in a component rule would beat the global cover. */
    assert.doesNotMatch(rule.body, /outline[^;]*!important/, `${rule.file}: ${rule.selector}`);
    const { compound } = subject(rule.selector);
    // The element that receives focus is the one this rule styles: the global !important outline reaches it.
    if (/:focus(?:-visible)?\b/.test(compound.replace(/:has\([^)]*\)/g, ""))) continue;
    // A wrapper (`X:has(input:focus-visible)` or `input:focus-visible + .mark`): it needs its own forced outline.
    if (!homeRules.some((other) => other.file === rule.file && other.selector === rule.selector && forcedOutline(other))) uncovered.push(`${rule.file}: ${rule.selector}`);
  }
  assert.deepEqual(uncovered, []);
});

test("every wrapper that shows a hidden input's focus has its own forced-colors outline", () => {
  /* Wrappers whose focus ring stands for an input that is not drawn (opacity 0 over the wrapper). Enumerated
     from the rules, then reconciled: each needs a forced outline on the same wrapper, or must be listed below
     because its input is drawn and so takes the global outline itself. */
  const inputDrawn = new Set([
    // .hm-todo-done-box, .hm-todo-check and the gate radio are visible 18-26px boxes; the global outline reaches them.
    ".hm-todo-done:has(input:focus-visible)", ".hm-todo-gate-kind:has(input:focus-visible)", ".hm-todo-check-hit:has(input:focus-visible)",
    // LiveDashboard: the purpose card's radio is a drawn 1.1rem native control.
    ".dashboard__choice-card:has(input:focus-visible)",
  ]);
  const wrappers = focusRules.filter((rule) => (suppresses(rule) || drawsRing(rule)) && !/:focus(?:-visible)?\b/.test(subject(rule.selector).compound.replace(/:has\([^)]*\)/g, "")));
  const wrapperKey = (selector: string): string => {
    const { compound } = subject(selector);
    const has = compound.match(/:has\([^)]*\)/)?.[0] ?? "";
    const classes = [...new Set(compound.match(/\.[\w-]+/g) ?? [])];
    return `${classes.at(-1) ?? compound}${has}|${has ? "" : subject(selector).before}`;
  };
  const forcedKeys = new Set(homeRules.filter(forcedOutline).map((rule) => wrapperKey(rule.selector)));
  const found = wrappers.map((rule) => rule.selector);
  assert.ok(found.includes(".hm-choice:has(input:focus-visible)") && found.includes(".hm-todo-row__box:focus-visible + .hm-todo-row__mark"),
    `positive control: the wrapper enumeration reaches the known wrappers: ${JSON.stringify(found)}`);
  const uncovered = wrappers.filter((rule) => !inputDrawn.has(rule.selector) && !forcedKeys.has(wrapperKey(rule.selector))).map((rule) => `${rule.file}: ${rule.selector}`);
  assert.deepEqual(uncovered, []);
  for (const selector of inputDrawn) assert.ok(found.includes(selector), `stale allowance: ${selector}`);
});

test("the mention picker's active row has a shape marker, not only a fill, in normal and forced colours", () => {
  const pickers = rules("styles/home/pickers.css", readFileSync(join(homeDir, "pickers.css"), "utf8"));
  const base = pickers.find((rule) => !rule.forced && rule.selector === ".hm-pick-option");
  const active = pickers.filter((rule) => !rule.forced && rule.selector === '.hm-pick-option[aria-selected="true"]');
  assert.ok(base && active.length > 0);
  const marker = active.find((rule) => /border-inline-start\s*:\s*3px solid var\(--home-lime-ink\)/.test(rule.body));
  assert.ok(marker, "the active row carries a 3px ink border on its start edge (a border survives forced colours; a box-shadow bar does not)");
  /* The border's width is taken back from the start padding, so the row's text does not move. */
  const basePadding = Number(base.body.match(/padding\s*:\s*\d+px\s+(\d+)px/)?.[1]);
  const activePadding = Number(marker.body.match(/padding-inline-start\s*:\s*(\d+)px/)?.[1]);
  assert.equal(activePadding + 3, basePadding);
  /* Inactive rows draw no start border, so the bar marks only the row Enter inserts. */
  assert.ok(!pickers.some((rule) => !rule.forced && rule.selector.startsWith(".hm-pick-option") && !rule.selector.includes('aria-selected="true"') && /border-inline-start\s*:/.test(rule.body)));
  const forced = pickers.find((rule) => rule.forced && rule.selector === '.hm-pick-option[aria-selected="true"]');
  assert.ok(forced && /border-inline-start-color\s*:\s*Highlight/.test(forced.body) && /background\s*:\s*Highlight/.test(forced.body));
  /* The listbox semantics stay: the field names the active row and the row says it is selected. */
  const view = read("src/lib/home-pickers.ts");
  assert.match(view, /aria-activedescendant/);
  assert.match(view, /aria-selected/);
});

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

/*
 * EFFECTIVE values. A forced-colors rule placed above a normal rule of the same specificity loses to it (the
 * code check found the picker caption doing exactly that). So the checks below run a small cascade: every
 * rule from global.css and the home stylesheets in their load order, selector matching against a described
 * element, and the winner by !important, then specificity, then source order. In forced mode the
 * forced-colors blocks join the normal rules; in normal mode they are left out.
 */
type El = { tag?: string; classes?: string[]; attrs?: Record<string, string>; states?: string[]; has?: string[]; parent?: El; prev?: El };
type Ranked = Rule & { order: number };

const topLevelSplit = (text: string, separator: string): string[] => {
  const out: string[] = []; let depth = 0, quote = "", from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth += 1; else if (char === ")" || char === "]") depth -= 1;
    else if (char === separator && depth === 0) { out.push(text.slice(from, i)); from = i + 1; }
  }
  out.push(text.slice(from));
  return out;
};
/** A selector as compounds and the combinators between them. */
function parseSelector(selector: string): { compounds: string[]; combinators: string[] } {
  const compounds: string[] = [], combinators: string[] = [];
  let depth = 0, current = "", pending = "";
  const flush = () => { if (current.trim()) { if (compounds.length) combinators.push(pending.trim() || " "); compounds.push(current.trim()); } current = ""; pending = ""; };
  for (const char of selector.trim()) {
    if (char === "(" || char === "[") depth += 1; else if (char === ")" || char === "]") depth -= 1;
    if (depth === 0 && (char === " " || char === ">" || char === "+" || char === "~")) { if (current.trim()) flush(); if (char !== " ") pending = char; continue; }
    current += char;
  }
  flush();
  return { compounds, combinators };
}
/** The simple selectors of one compound: tag, .class, [attr], :pseudo(args), ::pseudo-element. */
function simples(compound: string): string[] {
  const out: string[] = []; let i = 0;
  while (i < compound.length) {
    let j = i + 1;
    if (compound[i] === "[") { j = compound.indexOf("]", i) + 1; }
    else if (compound[i] === ":") {
      if (compound[j] === ":") j += 1;
      while (j < compound.length && /[\w-]/.test(compound[j]!)) j += 1;
      if (compound[j] === "(") { let depth = 0; for (; j < compound.length; j += 1) { if (compound[j] === "(") depth += 1; else if (compound[j] === ")") { depth -= 1; if (depth === 0) { j += 1; break; } } } }
    } else while (j < compound.length && /[\w-]/.test(compound[j]!)) j += 1;
    out.push(compound.slice(i, j)); i = j;
  }
  return out;
}
const pseudoArgs = (simple: string): string[] => topLevelSplit(simple.slice(simple.indexOf("(") + 1, -1), ",").map((part) => part.trim());
function matchSimple(el: El, simple: string): boolean {
  if (simple === "*") return true;
  if (simple.startsWith("::")) return false;
  if (simple.startsWith(".")) return (el.classes ?? []).includes(simple.slice(1));
  if (simple.startsWith("[")) {
    const m = simple.match(/^\[([\w-]+)(?:([\^*$]?=)"?([^"\]]*)"?)?\]$/); assert.ok(m, `attribute selector ${simple}`);
    const value = el.attrs?.[m[1]!]; if (value === undefined) return false;
    if (!m[2]) return true;
    return m[2] === "=" ? value === m[3] : m[2] === "^=" ? value.startsWith(m[3]!) : m[2] === "$=" ? value.endsWith(m[3]!) : value.includes(m[3]!);
  }
  if (simple.startsWith(":")) {
    const name = simple.match(/^:([\w-]+)/)![1]!;
    if (name === "not") return !pseudoArgs(simple).some((arg) => matches(el, arg));
    if (name === "is" || name === "where") return pseudoArgs(simple).some((arg) => matches(el, arg));
    if (name === "has") return pseudoArgs(simple).some((arg) => (el.has ?? []).includes(arg));
    return (el.states ?? []).includes(name);
  }
  return el.tag === simple;
}
function matches(el: El, selector: string): boolean {
  const { compounds, combinators } = parseSelector(selector);
  const at = (index: number, node: El | undefined): boolean => {
    if (!node || !simples(compounds[index]!).every((simple) => matchSimple(node, simple))) return false;
    if (index === 0) return true;
    const combinator = combinators[index - 1];
    if (combinator === ">") return at(index - 1, node.parent);
    if (combinator === "+") return at(index - 1, node.prev);
    const chain = combinator === "~" ? "prev" : "parent";
    for (let up = node[chain]; up; up = up[chain]) if (at(index - 1, up)) return true;
    return false;
  };
  return at(compounds.length - 1, el);
}
function specificity(selector: string): [number, number, number] {
  const total: [number, number, number] = [0, 0, 0];
  for (const compound of parseSelector(selector).compounds) for (const simple of simples(compound)) {
    if (simple.startsWith("::")) total[2] += 1;
    else if (/^:(?:not|is|has)\(/.test(simple)) {
      const best = pseudoArgs(simple).map(specificity).sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2])[0]!;
      total[0] += best[0]; total[1] += best[1]; total[2] += best[2];
    } else if (simple.startsWith(":where(")) continue;
    else if (simple.startsWith("#")) total[0] += 1;
    else if (simple.startsWith(".") || simple.startsWith("[") || simple.startsWith(":")) total[1] += 1;
    else if (simple !== "*") total[2] += 1;
  }
  return total;
}
const loadOrder = [...read("src/styles/home/index.css").matchAll(/@import "\.\/([\w-]+\.css)"/g)].map((m) => m[1]!);
const cascadeRules: Ranked[] = [
  ...rules("global.css", read("src/styles/global.css")),
  ...loadOrder.flatMap((name) => rules(`styles/home/${name}`, readFileSync(join(homeDir, name), "utf8"))),
  ...rules("LiveDashboard.astro <style>", dashboardStyles),
].map((rule, order) => ({ ...rule, order }));
/** [important, a, b, c, source order]: the first difference decides; a later rule wins a tie on everything else. */
const outranks = (key: number[], other: number[]): boolean => { for (let i = 0; i < key.length; i += 1) if (key[i] !== other[i]) return key[i]! > other[i]!; return false; };
/** The winning declaration for `property` on `el` (longhand or one of its shorthands), or null. */
function effective(el: El, property: string, mode: "normal" | "forced"): { value: string; from: string } | null {
  const names = new Set([property, ...({ "background-color": ["background"], "border-inline-start-color": ["border-inline-start", "border-color", "border"],
    "border-inline-start-width": ["border-inline-start", "border-width", "border"], "outline-style": ["outline"] } as Record<string, string[]>)[property] ?? []]);
  let best: { value: string; from: string; key: number[] } | null = null;
  for (const rule of cascadeRules) {
    if (rule.forced && mode === "normal") continue;
    if (!matches(el, rule.selector)) continue;
    for (const declaration of topLevelSplit(rule.body, ";")) {
      const colon = declaration.indexOf(":"); if (colon === -1) continue;
      const name = declaration.slice(0, colon).trim(); if (!names.has(name)) continue;
      const raw = declaration.slice(colon + 1).trim(); const important = /!important$/.test(raw);
      const key = [important ? 1 : 0, ...specificity(rule.selector), rule.order];
      if (!best || outranks(key, best.key)) {
        best = { value: raw.replace(/\s*!important$/, ""), from: `${rule.file}: ${rule.selector}`, key };
      }
    }
  }
  return best && { value: best.value, from: best.from };
}

test("the cascade helper reproduces known winners (positive controls)", () => {
  /* Positive controls for the matcher itself on known rules. */
  const chip: El = { tag: "button", classes: ["hm-assign-chip"], states: ["focus-visible"], parent: { tag: "div", classes: ["hm-picker"] } };
  assert.equal(effective(chip, "outline", "normal")?.value, "none", "the chip's own rule suppresses the outline in normal mode");
  assert.equal(effective(chip, "outline", "forced")?.value, "3px solid Highlight", "global.css's !important outline wins in forced mode");
  const heading: El = { tag: "h1", attrs: { tabindex: "-1" }, states: ["focus-visible"], parent: { tag: "section", classes: ["pd-page"], attrs: { "data-people-page": "" } } };
  assert.notEqual(effective(heading, "outline", "forced")?.value, "3px solid Highlight !important", "a route-target heading is outside the !important cover");
});

const pickOption = (selected: boolean): El => {
  const card: El = { tag: "div", classes: ["hm-picker", "hm-tag-picker"] };
  const pop: El = { tag: "div", classes: ["hm-picker-pop"], parent: card };
  const list: El = { tag: "div", classes: ["hm-pick-list"], attrs: { role: "listbox" }, parent: pop };
  const group: El = { tag: "div", classes: ["hm-pick-group"], parent: list };
  return { tag: "div", classes: ["hm-pick-option"], attrs: { role: "option", "aria-selected": String(selected), "data-pick-state": "connected" }, parent: group };
};
const inOption = (option: El, className: string): El => ({ tag: "span", classes: [className], parent: { tag: "span", classes: ["hm-pick-copy"], parent: option } });

test("the mention picker's active row has a shape marker, not only a fill, in normal and forced colours", () => {
  const active = pickOption(true), inactive = pickOption(false);
  /* Normal: lime fill plus a 3px ink bar; the start padding gives the bar's width back, so the text does not move. */
  assert.equal(effective(active, "border-inline-start", "normal")?.value, "3px solid var(--home-lime-ink)");
  assert.equal(effective(active, "background-color", "normal")?.value, "var(--home-lime)");
  const basePadding = Number(effective(inactive, "padding", "normal")?.value.match(/^\d+px\s+(\d+)px$/)?.[1]);
  assert.equal(Number(effective(active, "padding-inline-start", "normal")?.value.replace("px", "")) + 3, basePadding);
  /* Inactive rows draw no start border, so the bar marks only the row Enter inserts. */
  assert.equal(effective(inactive, "border-inline-start-width", "normal"), null);
  assert.equal(effective(inactive, "border-inline-start-width", "forced"), null);
  /* Forced colours: the selected-row system pair, and the bar keeps its width. */
  assert.equal(effective(active, "background-color", "forced")?.value, "Highlight");
  assert.equal(effective(active, "color", "forced")?.value, "HighlightText");
  assert.equal(effective(active, "border-inline-start-color", "forced")?.value, "Highlight");
  assert.match(effective(active, "border-inline-start-width", "forced")?.value ?? "", /^3px\b/);
  /* Every text in the active row reads on that Highlight fill: its EFFECTIVE colour is HighlightText or inherited
     from the row. The code check found the caption losing to the later lime-ink rule. */
  for (const part of ["hm-pick-label", "hm-pick-caption"]) {
    const value = effective(inOption(active, part), "color", "forced");
    assert.ok(value === null || value.value === "HighlightText", `${part} in forced colours: ${JSON.stringify(value)}`);
  }
  /* Positive control on the same helper: in normal mode the caption is the lime ink, so the lookup reaches it. */
  assert.equal(effective(inOption(active, "hm-pick-caption"), "color", "normal")?.value, "var(--home-lime-ink)");
  /* The listbox semantics stay: the field names the active row and the row says it is selected. */
  const view = read("src/lib/home-pickers.ts");
  assert.match(view, /aria-activedescendant/);
  assert.match(view, /aria-selected/);
});

test("each forced-colors focus outline added for a hidden input is the effective value, not overridden later", () => {
  const pane: El = { tag: "section", classes: ["hm-route-pane"], attrs: { "data-home-route-pane": "" } };
  const todoChoice: El = { tag: "label", classes: ["hm-choice"], has: ["input:focus-visible"], parent: { tag: "div", classes: ["hm-todo-start"], parent: { tag: "div", classes: ["hm-todo"], parent: pane } } };
  const choice: El = { tag: "label", classes: ["hm-choice"], has: ["input:focus-visible"], parent: { tag: "div", classes: ["hm-choice-options"], parent: pane } };
  const row: El = { tag: "div", classes: ["hm-todo-row"] };
  const box: El = { tag: "input", classes: ["hm-todo-row__box"], attrs: { type: "checkbox" }, states: ["focus-visible"], parent: row };
  const mark: El = { tag: "span", classes: ["hm-todo-row__mark"], prev: box, parent: row };
  const card: El = { tag: "label", classes: ["hm-new-workspace__purpose-card"], has: ["input:focus-visible"], parent: { tag: "div", classes: ["hm-new-workspace"] } };
  for (const [name, el] of [["to-do start choice", todoChoice], ["choice", choice], ["to-do row mark", mark], ["purpose card", card]] as const) {
    assert.equal(effective(el, "outline", "forced")?.value, "3px solid Highlight", `${name}: ${JSON.stringify(effective(el, "outline", "forced"))}`);
    assert.notEqual(effective(el, "outline", "normal")?.value, "3px solid Highlight", `${name}: the outline is forced-colours only`);
  }
});

// Pure DOM builders. Dynamic content enters only through textContent.
import type { AgentStateVM, AgentVM, CapsuleVM, ChoiceVM, NeedsYouVM, ObjectCardVM, PersonVM, QueueRowVM, SwitchRowVM } from "./home-types";
import { IDENTITY_LABEL_SEPARATOR } from "./identity-label";
import { agentLabel, ordinal, personTint } from "./home-names";

export type NoticeTone = "info" | "warning" | "danger" | "success";
export type QueueAction = "up" | "down" | "start-now" | "not-yet" | "release";
/** The frozen models lack a shared sample flag; callers may supply this optional extension. */
export type SamplePrimitive<T> = T & { sample?: boolean };
const isSample = (value: object) => (value as { sample?: boolean }).sample === true;

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(doc: Document, label: string, action: () => void): HTMLButtonElement {
  const b = node(doc, "button", "hm-button", label); b.type = "button";
  b.addEventListener("click", action); return b;
}
function decorative(element: HTMLElement): HTMLElement { element.setAttribute("aria-hidden", "true"); return element; }

/** Never let an object reference or action link execute script. */
export function safeHomeHref(value: string): string | null {
  if (!value || /[\u0000-\u0020\\]/u.test(value)) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  if (value.startsWith("#")) return value;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? value : null; }
  catch { return null; }
}
export function capsuleLabel(c: CapsuleVM): string {
  const names = c.agents.map(a => a.nestedLabel);
  return names.length ? `${c.person.firstName || c.person.name} with ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}` : c.person.name;
}
export function queueMoveReceipt(title: string, position: number): string { return `Moved ‘${title}’ to ${ordinal(position)}.`; }
/** Text the roster added after the base label it built from the name and owner. */
function disambiguationSuffix(base: string, shown: string | undefined): string {
  if (!shown || shown === base) return "";
  const prefix = `${base}${IDENTITY_LABEL_SEPARATOR}`;
  return shown.startsWith(prefix) ? shown.slice(prefix.length) : "";
}
/** Name, owner, the roster's id suffix, and status. The owner's full name is what the roster used when first names collide. */
function accessibleLabelInput(a: AgentVM) {
  return { name: a.name, ownerId: a.ownerId, ownerName: a.ownerFirstName, ownerFirstName: a.ownerFirstName,
    yours: a.yours, ownerLeft: a.ownerId === null };
}
export function agentAccessibleName(a: AgentVM): string {
  const owner = a.yours ? "your agent" : a.ownerFirstName ? `${a.ownerFirstName}’s agent` : "owner left";
  const input = accessibleLabelInput(a);
  const nested = disambiguationSuffix(agentLabel(input, { nested: true }), a.nestedLabel);
  const alone = disambiguationSuffix(agentLabel(input), a.label);
  const suffix = nested.length >= alone.length ? nested : alone;
  const shown = suffix ? `${a.name}${IDENTITY_LABEL_SEPARATOR}${suffix}` : a.name;
  return `${shown}, ${owner}, ${a.state.word}`;
}

/** The visible mark is one character, as in the canvas design; the accessible name is the full name. */
const firstCharacter = (text: string) => Array.from(text.trim())[0] ?? "";
/** The person's colour set ("0"-"3"), or "none" for an agent whose owner left. */
const hue = (tint: number | null) => (tint === null ? "none" : String(tint));

/** Person avatar circle (24, 28, 30, 36, 44 or 48 px), filled in the person's colour. Dashed when invited and not joined. */
export function personAvatar(doc: Document, p: PersonVM, size: number): HTMLElement {
  const avatar = node(doc, "span", "hm-person-avatar", firstCharacter(p.initials));
  avatar.dataset.size = String(size); avatar.dataset.dashed = String(!!p.dashed);
  avatar.dataset.hue = hue(personTint(p.id, p.you));
  avatar.setAttribute("role", "img"); avatar.setAttribute("aria-label", p.name); avatar.title = p.name;
  return avatar;
}
/** Agent avatar (22, 24, 26, 28, 32, 36 or 60 px): a rounded square in the owner's colour, with an optional owner badge. */
export function agentOrb(doc: Document, a: AgentVM, opts: { size: number; badge: boolean }): HTMLElement {
  const orb = node(doc, "span", "hm-agent-orb"); orb.dataset.size = String(opts.size);
  orb.dataset.tint = String(a.tint); orb.dataset.dashed = String(!!a.dashed);
  orb.dataset.hue = hue(personTint(a.ownerId, a.yours));
  orb.setAttribute("role", "img"); orb.setAttribute("aria-label", agentAccessibleName(a)); orb.title = a.label;
  // The letter keeps the name's own case ("d" for dot), as the canvas design shows it.
  const letter = Array.from(a.name.replace(/[^\p{L}\p{N}]/gu, ""))[0] ?? "";
  orb.append(decorative(node(doc, "span", "hm-orb-letter", letter)));
  if (opts.badge && a.ownerId !== null) orb.append(decorative(node(doc, "span", "hm-owner-badge", a.ownerInitial)));
  return orb;
}
/** A person with up to three agents, then +N. Interactive form is one button. */
export function capsule(doc: Document, c: CapsuleVM, opts?: { compact?: boolean; onOpen?: (c: CapsuleVM) => void }): HTMLElement {
  const interactive = !!opts?.onOpen && !isSample(c);
  const root = interactive ? button(doc, "", () => opts!.onOpen!(c)) : node(doc, "span", "hm-capsule");
  root.className = "hm-capsule"; root.setAttribute("aria-label", capsuleLabel(c));
  if (!interactive) root.setAttribute("role", "img");
  root.append(decorative(personAvatar(doc, c.person, 30)));
  for (const agent of c.agents.slice(0, 3)) root.append(decorative(agentOrb(doc, agent, { size: 26, badge: false })));
  if (c.agents.length > 3) root.append(decorative(node(doc, "span", "hm-capsule-more", `+${c.agents.length - 3}`)));
  if (!opts?.compact) root.append(decorative(node(doc, "span", "hm-capsule-name", c.person.firstName || c.person.name)));
  return root;
}
/** Shape, word, measured detail; fixes are visible notices in expanded forms. */
export function statusLine(doc: Document, s: AgentStateVM, opts: { form: "word" | "line" | "pill" }): HTMLElement {
  const root = node(doc, "span", "hm-status"); root.dataset.state = s.kind; root.dataset.form = opts.form;
  root.setAttribute("aria-label", [s.word, s.detail, s.attention ? s.fix.sentence : ""].filter(Boolean).join(". "));
  const shape = decorative(node(doc, "span", "hm-status-shape")); shape.dataset.shape = s.kind === "working" ? "dot" : s.kind === "idle" ? "ring" : "diamond";
  root.append(shape, node(doc, "span", "hm-status-word", s.word));
  if (opts.form === "word") root.title = s.detail;
  else root.append(node(doc, "span", "hm-status-detail", s.detail));
  if (s.attention && s.fix.sentence && opts.form !== "word") root.append(notice(doc, s.fix.sentence, "warning"));
  return root;
}
/** The canvas design's line icon for an object kind (or an ask). The shape is a CSS mask in primitives.css,
 *  painted in currentColor; this element carries no text. 22 px by default, sized by the surface. */
export function objectIcon(doc: Document, kind: ObjectCardVM["kind"] | "ask"): HTMLElement {
  const icon = node(doc, "span", "hm-object-icon"); icon.dataset.icon = kind;
  return icon;
}
const SVG_NS = "http://www.w3.org/2000/svg";
/** The canvas's 16 px padlock (Todo.dc.html: rect 3,7 10x7 rx 1.8 and the shackle, stroke 1.6), drawn in currentColor;
 *  decorative. The surface names its class (the agent page's policy note, the to-do's steer line). */
export function lockIcon(doc: Document, className: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  for (const [name, value] of [["class", className], ["width", "16"], ["height", "16"], ["viewBox", "0 0 16 16"], ["fill", "none"],
    ["stroke", "currentColor"], ["stroke-width", "1.6"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"],
    ["focusable", "false"]]) svg.setAttribute(name, value);
  const body = doc.createElementNS(SVG_NS, "rect");
  for (const [name, value] of [["x", "3"], ["y", "7"], ["width", "10"], ["height", "7"], ["rx", "1.8"]]) body.setAttribute(name, value);
  const shackle = doc.createElementNS(SVG_NS, "path"); shackle.setAttribute("d", "M5.5 7V5a2.5 2.5 0 0 1 5 0v2");
  svg.append(body, shackle);
  return svg;
}
/** A needs-you card whose sender is unknown (no name, no initials) shows a neutral glyph, never a blank colour. */
export function needsYouUnknownSender(n: NeedsYouVM): boolean {
  return !("label" in n.from) && !Array.from(n.from.initials.trim()).length;
}
/** To-do, list, doc or file card: one link, 56 px minimum. */
export function objectCard(doc: Document, o: ObjectCardVM): HTMLElement {
  const href = !isSample(o) ? safeHomeHref(o.href) : null;
  const root = href ? node(doc, "a", "hm-object-card") : node(doc, "div", "hm-object-card");
  if (href) (root as HTMLAnchorElement).href = href;
  root.dataset.objectId = o.id; root.dataset.kind = o.kind; root.dataset.done = String(!!o.done);
  const kinds = { todo: "To-do", list: "List", doc: "Doc", file: "File" };
  const icon = objectIcon(doc, o.kind); icon.setAttribute("role", "img"); icon.setAttribute("aria-label", kinds[o.kind]);
  const text = node(doc, "span", "hm-object-copy"); const title = node(doc, "strong", "hm-object-title", o.title); title.title = o.title;
  text.append(title, node(doc, "span", "hm-object-meta", `${o.done ? "Done · " : ""}${o.meta}`)); root.append(icon, text);
  if (o.who) root.append("label" in o.who ? agentOrb(doc, o.who, { size: 28, badge: true }) : personAvatar(doc, o.who, 28));
  return root;
}
/** Needs you, with links or callback actions. */
export function needsYouCard(doc: Document, n: NeedsYouVM, onAction: (action: string, n: NeedsYouVM) => void): HTMLElement {
  const root = node(doc, "article", "hm-needs-you"); root.dataset.needsYou = n.id;
  const heading = node(doc, "h3", "hm-needs-title", n.what); heading.id = `hm-needs-${encodeURIComponent(n.id)}`;
  root.setAttribute("aria-labelledby", heading.id);
  if (needsYouUnknownSender(n)) {
    const glyph = node(doc, "span", "hm-needs-glyph"); glyph.setAttribute("role", "img"); glyph.setAttribute("aria-label", n.from.name);
    glyph.append(decorative(objectIcon(doc, n.kind === "ask" ? "ask" : "todo"))); root.append(glyph);
  } else root.append("label" in n.from ? agentOrb(doc, n.from, { size: 36, badge: true }) : personAvatar(doc, n.from, 36));
  const copy = node(doc, "div", "hm-needs-copy"); copy.append(node(doc, "p", "hm-eyebrow", ["Needs you", n.workspace.name, n.when].filter(Boolean).join(" · ")), heading);
  const actions = node(doc, "div", "hm-actions");
  if (!isSample(n)) for (const [index, action] of [n.primary, n.secondary].entries()) {
    if (!action) continue;
    const href = action.href ? safeHomeHref(action.href) : null;
    const control = href ? node(doc, "a", "hm-button", action.label) : action.action ? button(doc, action.label, () => onAction(action.action!, n)) : null;
    if (!control) continue;
    if (href) (control as HTMLAnchorElement).href = href;
    control.dataset.primary = String(index === 0); actions.append(control);
  }
  if (actions.childElementCount) copy.append(actions);
  root.append(copy); return root;
}
/** Native radios, with no preselection for a null value and a visible check mark. */
export function choiceChips<V extends string>(doc: Document, c: ChoiceVM<V>, onChange: (value: V) => void): HTMLElement {
  const fieldset = node(doc, "fieldset", "hm-choices"); fieldset.append(node(doc, "legend", "hm-legend", c.legend));
  const choices = node(doc, "div", "hm-choice-options");
  for (const option of c.options) {
    if (isSample(c)) {
      const chip = node(doc, "span", "hm-choice"); chip.dataset.static = "true"; chip.dataset.selected = String(c.value === option.value);
      chip.append(decorative(node(doc, "span", "hm-choice-check", "✓")), node(doc, "span", "hm-choice-copy", option.label));
      if (option.hint) chip.append(node(doc, "span", "hm-choice-hint", option.hint));
      choices.append(chip); continue;
    }
    const label = node(doc, "label", "hm-choice"); const input = node(doc, "input", "hm-radio");
    input.type = "radio"; input.name = c.name; input.value = option.value; input.checked = c.value === option.value;
    input.disabled = !!option.disabled || isSample(c);
    input.addEventListener("change", () => { if (input.checked && !input.disabled) onChange(option.value); });
    const check = decorative(node(doc, "span", "hm-choice-check", "✓"));
    const copy = node(doc, "span", "hm-choice-copy", option.label);
    if (option.hint) copy.append(node(doc, "span", "hm-choice-hint", option.hint));
    label.append(input, check, copy); choices.append(label);
  }
  fieldset.append(choices); return fieldset;
}
/** Always and Never are static facts. Busy switches retain their measured state. */
export function switchRow(doc: Document, s: SwitchRowVM, onToggle: (s: SwitchRowVM) => void): HTMLElement {
  const interactive = (s.state === "on" || s.state === "off") && !isSample(s);
  const root = interactive ? button(doc, "", () => { if (!s.busy && !s.disabled) onToggle(s); }) : node(doc, "div", "hm-switch-row");
  root.className = "hm-switch-row"; root.dataset.switchId = s.id;
  const copy = node(doc, "span", "hm-switch-copy"); copy.append(node(doc, "strong", "hm-switch-label", s.label), node(doc, "span", "hm-switch-detail", s.detail));
  root.append(copy);
  const words = { on: "On", off: "Off", always: "Always", never: "Never", unavailable: "Not available" };
  if (interactive) {
    const b = root as HTMLButtonElement; b.setAttribute("role", "switch"); b.setAttribute("aria-checked", String(s.state === "on"));
    b.disabled = !!s.busy || !!s.disabled; b.setAttribute("aria-busy", String(!!s.busy));
    const track = decorative(node(doc, "span", "hm-switch-track")); track.append(node(doc, "span", "hm-switch-knob")); root.append(track);
  }
  root.append(node(doc, "span", "hm-switch-word", words[s.state])); return root;
}
/** One numbered row of an agent's line. Flags are measured permissions, not promises. */
export function queueRow(doc: Document, q: QueueRowVM, onAction: (action: QueueAction, q: QueueRowVM) => void): HTMLElement {
  const row = node(doc, "li", "hm-queue-row"); row.dataset.queueId = q.todoId; row.dataset.position = String(q.position);
  row.append(node(doc, "span", "hm-queue-position", String(q.position)));
  const copy = node(doc, "div", "hm-queue-copy"); const href = !isSample(q) ? safeHomeHref(q.href) : null;
  const title = href ? node(doc, "a", "hm-queue-title", q.title) : node(doc, "span", "hm-queue-title", q.title);
  if (href) (title as HTMLAnchorElement).href = href;
  copy.append(title, node(doc, "span", "hm-queue-meta", q.meta)); row.append(copy);
  const actions = node(doc, "div", "hm-actions");
  const options: { action: QueueAction; label: string; allowed: boolean }[] = [
    { action: "up", label: "Move up", allowed: q.may.up }, { action: "down", label: "Move down", allowed: q.may.down },
    { action: "start-now", label: "Start now", allowed: q.may.startNow }, { action: "not-yet", label: "Not yet", allowed: q.may.notYet },
    { action: "release", label: "Release", allowed: q.may.release },
  ];
  if (!isSample(q)) for (const option of options.filter(item => item.allowed)) {
    const control = button(doc, option.label, () => {
      const list = row.closest("ul, ol");
      const lineage: { parent: Element; index: number }[] = [];
      for (let child: Element | null = list; child?.parentElement; child = child.parentElement) {
        lineage.push({ parent: child.parentElement, index: Array.from(child.parentElement.children).indexOf(child) });
      }
      const currentList = (): Element | null => {
        if (list?.isConnected) return list;
        const anchor = lineage.findIndex(step => step.parent.isConnected);
        if (anchor < 0) return null;
        let replacement: Element | undefined = lineage[anchor].parent;
        for (let i = anchor; i >= 0; --i) replacement = replacement?.children[lineage[i].index];
        return replacement?.matches("ul, ol") ? replacement : null;
      };
      const completion = onAction(option.action, q);
      if (option.action !== "up" && option.action !== "down") return;
      // Read the rerendered row's actual position, never predict a successful move.
      const finishMove = () => {
        const moved = Array.from(currentList()?.querySelectorAll<HTMLElement>("[data-queue-id]") ?? []).find(item => item.dataset.queueId === q.todoId);
        if (!moved || moved.dataset.position === String(q.position)) return false;
        Array.from(moved.querySelectorAll<HTMLButtonElement>("[data-queue-action]")).find(item => item.dataset.queueAction === option.action)?.focus();
        const region = moved.querySelector<HTMLElement>("[data-queue-receipt]");
        const position = Number(moved.dataset.position);
        if (region && Number.isInteger(position) && position > 0) region.textContent = queueMoveReceipt(q.title, position);
        return true;
      };
      // Some page callbacks rebuild their entire section after an async command.
      const Observer = doc.defaultView?.MutationObserver;
      let timer: number | undefined;
      const observer: MutationObserver | null = Observer ? new Observer(() => {
        if (finishMove() || !currentList()) { observer?.disconnect(); doc.defaultView?.clearTimeout(timer); }
      }) : null;
      if (!finishMove() && observer) {
        observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-position"] });
        timer = doc.defaultView?.setTimeout(() => observer.disconnect(), 30_000);
      }
      // Void callbacks may return an async command promise. Failed commands have no move receipt.
      void Promise.resolve(completion).then(() => { if (finishMove()) { observer?.disconnect(); doc.defaultView?.clearTimeout(timer); } }, () => { observer?.disconnect(); doc.defaultView?.clearTimeout(timer); });
    });
    control.dataset.queueAction = option.action;
    if (option.action === "up" || option.action === "down") control.setAttribute("aria-label", `Move ‘${q.title}’ ${option.action}`);
    actions.append(control);
  }
  if (actions.childElementCount) row.append(actions);
  const receipt = node(doc, "span", "hm-sr-only"); receipt.dataset.queueReceipt = ""; receipt.setAttribute("aria-live", "polite"); receipt.setAttribute("aria-atomic", "true"); row.append(receipt);
  return row;
}
/** Tone is carried by words as well as colour. */
export function notice(doc: Document, text: string, tone: NoticeTone): HTMLElement {
  const labels = { info: "Note", warning: "Attention", danger: "Problem", success: "Done" };
  const root = node(doc, "span", "hm-notice"); root.dataset.tone = tone;
  root.append(node(doc, "strong", "hm-notice-tone", `${labels[tone]}: `), node(doc, "span", "hm-notice-text", text));
  return root;
}

// Home UI shared DOM builders (UI-SPEC.md section 2.2). Signatures frozen by the Lead's scaffold;
// lane P implements the bodies. Every builder takes a Document and a view model, puts user text in
// through textContent only, renders no actions in sample mode, and gives every target 44 px or more.
import type { AgentStateVM, AgentVM, CapsuleVM, ChoiceVM, NeedsYouVM, ObjectCardVM, PersonVM, QueueRowVM, SwitchRowVM } from "./home-types";

export type NoticeTone = "info" | "warning" | "danger" | "success";
export type QueueAction = "up" | "down" | "start-now" | "not-yet" | "release";

const pending = (name: string): never => { throw new Error(`home-primitives: ${name} is not implemented yet (lane P)`); };

/** Person avatar circle (24, 28, 36, 44 or 48 px). Dashed when invited and not joined. */
export function personAvatar(doc: Document, p: PersonVM, size: number): HTMLElement { void doc; void p; void size; return pending("personAvatar"); }
/** Agent orb (22, 28, 36 or 60 px) with an optional owner badge (only when the agent is shown alone). */
export function agentOrb(doc: Document, a: AgentVM, opts: { size: number; badge: boolean }): HTMLElement { void doc; void a; void opts; return pending("agentOrb"); }
/** A person with their agents. Compact = avatars only (role="img"); with onOpen it is one button. */
export function capsule(doc: Document, c: CapsuleVM, opts?: { compact?: boolean; onOpen?: (c: CapsuleVM) => void }): HTMLElement { void doc; void c; void opts; return pending("capsule"); }
/** Status: shape + word (+ measured detail). Never colour alone. */
export function statusLine(doc: Document, s: AgentStateVM, opts: { form: "word" | "line" | "pill" }): HTMLElement { void doc; void s; void opts; return pending("statusLine"); }
/** To-do, list, doc or file card: one link, 56 px minimum. */
export function objectCard(doc: Document, o: ObjectCardVM): HTMLElement { void doc; void o; return pending("objectCard"); }
/** "Needs you" card with a primary and an optional secondary action. */
export function needsYouCard(doc: Document, n: NeedsYouVM, onAction: (action: string, n: NeedsYouVM) => void): HTMLElement { void doc; void n; void onAction; return pending("needsYouCard"); }
/** Radio chips in a real fieldset with a legend; null value = nothing preselected. */
export function choiceChips<V extends string>(doc: Document, c: ChoiceVM<V>, onChange: (value: V) => void): HTMLElement { void doc; void c; void onChange; return pending("choiceChips"); }
/** role="switch" row; "always" and "never" render as text, not a switch. */
export function switchRow(doc: Document, s: SwitchRowVM, onToggle: (s: SwitchRowVM) => void): HTMLElement { void doc; void s; void onToggle; return pending("switchRow"); }
/** One numbered row of an agent's line, with 44 px move/start/hold buttons gated by q.may. */
export function queueRow(doc: Document, q: QueueRowVM, onAction: (action: QueueAction, q: QueueRowVM) => void): HTMLElement { void doc; void q; void onAction; return pending("queueRow"); }
/** A short notice line; tone is also carried in text, never colour alone. */
export function notice(doc: Document, text: string, tone: NoticeTone): HTMLElement { void doc; void text; void tone; return pending("notice"); }

// To-do receipts and status lines (UI-SPEC.md 3.1, amended by Lead rulings R4, R5, R6, R7 and R10).
// Pure functions from a TodoVM plus the clock to strings. Nothing else renders to-do status.
// The screen word for an agent's ordered list is "line" (R10); the server word stays internal.
import type { AgentVM, ChoiceVM, Id, PersonVM, TodoVM } from "./home-types";

/** What the copy needs besides the to-do. `now` is passed in; nothing here reads the clock.
 * `receive` is the agent's receive sentence from agent-status ("Checks messages when Nikki chats
 * with it."); the view models do not carry it, so integration passes it or leaves it null.
 * `notice` is the outcome of the message the last Start now asked for (SERVER-PLAN A9: the move
 * can commit with `notice: not_sent`); TodoVM does not carry it. `names` maps person ids to the
 * name to show where two people share a first name (home-pickers `personNames`). */
export interface TodoCopyContext { now: number; timeZone?: string; receive?: string | null; notice?: TodoNotice | null; names?: ReadonlyMap<Id, string> }
export type TodoNotice = "sent" | "not_sent";
export type TodoStartMode = "queue" | "now" | "gated" | "at";
export interface TodoStatusCopy { line: string; more: string[]; warning: string | null }

export const TODO_SAVE_FAILED = "Not saved. Check your connection and try again.";
export const TODO_RESULT_UNKNOWN = "The result is unknown. Reload to check.";
export const TODO_NOT_ASSIGNED = "Not assigned yet";
export const TODO_PEOPLE_NO_LINE = "People have no line order or start time.";
/** Chip labels, in the order the To-do view shows them (UI-SPEC 3.4). */
export const TODO_START_LABELS: Readonly<Record<TodoStartMode, string>> = {
  queue: "When it’s free", now: "Now", gated: "Not yet", at: "At a set time",
};
const START_ORDER: TodoStartMode[] = ["queue", "now", "gated", "at"];

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

export const isAgent = (who: PersonVM | AgentVM): who is AgentVM => "state" in who;
const possessive = (name: string) => `${name}’s`;
const lowerFirst = (text: string) => text && !/^\p{Lu}{2}/u.test(text) ? text[0]!.toLocaleLowerCase() + text.slice(1) : text;
const sentenceEnd = (text: string) => /[.!?…]$/u.test(text) ? text : `${text}.`;

/** A person's name: the first name, or the full name where `names` says two people share it. */
export function personName(person: PersonVM, names?: ReadonlyMap<Id, string>): string {
  return names?.get(person.id) || person.firstName;
}
/** A name in the middle of a sentence: "your Claude", "Nikki’s Muse", "you", "Nikki". */
export function sentenceName(who: PersonVM | AgentVM, names?: ReadonlyMap<Id, string>): string {
  if (isAgent(who)) return who.yours && who.label.startsWith("Your ") ? `your ${who.label.slice(5)}` : who.label;
  return who.you ? "you" : personName(who, names);
}
/** The same name at the start of a line: "Your Claude", "You", "Nikki". */
export function displayName(who: PersonVM | AgentVM, names?: ReadonlyMap<Id, string>): string {
  if (isAgent(who)) return who.label;
  return who.you ? "You" : personName(who, names);
}

// ---- Time (local to this lane; mirrors lane P's formatWhen until integration joins them) ----
interface Day { y: number; m: number; d: number }
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
function zoned(ms: number, timeZone?: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "short", day: "numeric", weekday: "short",
    hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return { day: { y: Number(get("year")), m: months.indexOf(get("month")) + 1, d: Number(get("day")) }, weekday: get("weekday"),
    month: get("month"), clock: `${get("hour")}:${get("minute")} ${get("dayPeriod").toLocaleLowerCase()}` };
}
const dayNumber = (day: Day) => Date.UTC(day.y, day.m - 1, day.d) / 86_400_000;
function calendar(value: string, ctx: TodoCopyContext): { day: Day; label: string; clock: string | null } | null {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const day = { y: Number(dateOnly[1]), m: Number(dateOnly[2]), d: Number(dateOnly[3]) };
    const noon = zoned(Date.UTC(day.y, day.m - 1, day.d, 12), "UTC");
    return { day, label: `${noon.weekday}, ${noon.month} ${day.d}`, clock: null };
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const at = zoned(ms, ctx.timeZone);
  return { day: at.day, label: `${at.weekday}, ${at.month} ${at.day.d}`, clock: at.clock };
}
function relative(day: Day, ctx: TodoCopyContext): "today" | "yesterday" | "tomorrow" | null {
  const offset = dayNumber(day) - dayNumber(zoned(ctx.now, ctx.timeZone).day);
  return offset === 0 ? "today" : offset === -1 ? "yesterday" : offset === 1 ? "tomorrow" : null;
}
const withYear = (label: string, day: Day, ctx: TodoCopyContext) => day.y === zoned(ctx.now, ctx.timeZone).day.y ? label : `${label}, ${day.y}`;

/** "today", "yesterday", "tomorrow" or "Fri, Oct 9"; null when the value is not a date. */
export function whenDay(value: string, ctx: TodoCopyContext): string | null {
  const at = calendar(value, ctx);
  return at ? relative(at.day, ctx) ?? withYear(at.label, at.day, ctx) : null;
}
/** A moment ahead or behind: "9:00 pm today", "9:00 am tomorrow" or "Fri, Oct 9, 9:00 am". */
export function whenAt(value: string, ctx: TodoCopyContext): string | null {
  const at = calendar(value, ctx);
  if (!at) return null;
  if (!at.clock) return whenDay(value, ctx);
  const near = relative(at.day, ctx);
  return near ? `${at.clock} ${near}` : `${withYear(at.label, at.day, ctx)}, ${at.clock}`;
}
/** A stamp on something that happened: "10:40 am" today, "Yesterday, 6:52 pm", or "Fri, Oct 2, 6:52 pm". */
export function whenStamp(value: string, ctx: TodoCopyContext): string | null {
  const at = calendar(value, ctx);
  if (!at) return null;
  const near = relative(at.day, ctx);
  if (!at.clock) return near ? near[0]!.toLocaleUpperCase() + near.slice(1) : withYear(at.label, at.day, ctx);
  if (near === "today") return at.clock;
  return `${near === "yesterday" ? "Yesterday" : withYear(at.label, at.day, ctx)}, ${at.clock}`;
}

// ---- Lines ----

/** "Added by Nikki yesterday · Due Fri, Oct 9". Unknown dates are left out, never guessed. */
export function todoMetaLine(todo: TodoVM, ctx: TodoCopyContext): string {
  const at = calendar(todo.addedAt, ctx);
  const day = at ? relative(at.day, ctx) ?? `on ${withYear(at.label, at.day, ctx)}` : null;
  const added = `Added by ${sentenceName(todo.addedBy, ctx.names)}${day ? ` ${day}` : ""}`;
  const due = todo.due ? whenDay(todo.due, ctx) : null;
  return due ? `${added} · Due ${due}` : added;
}

/** The label on the assign picker trigger; the same names the picker rows use. */
export function todoAssigneeLabel(todo: TodoVM, names?: ReadonlyMap<Id, string>): string {
  const assignee = todo.assignee;
  if (!assignee) return TODO_NOT_ASSIGNED;
  if (assignee.kind === "agent") return assignee.agent.label;
  const name = personName(assignee.person, names);
  return assignee.person.you ? `${name} (you)` : name;
}

function disconnectedSentence(agent: AgentVM): string {
  const detail = agent.state.detail.trim();
  const why = detail ? ` (${lowerFirst(detail)})` : "";
  return agent.state.word === "Not picking up"
    ? `${agent.nestedLabel} is not picking up messages${why}, so nothing moves until it checks them.`
    : `${agent.nestedLabel} is disconnected${why}, so nothing moves until it reconnects.`;
}
function fixSentence(agent: AgentVM): string | null {
  const fix = agent.state.fix;
  if (fix.allowed && fix.sentence) return fix.sentence;
  if (fix.askWho) return `Ask ${fix.askWho} to reconnect it.`;
  return fix.sentence || null;
}

function gateLine(todo: TodoVM, agent: AgentVM, ctx: TodoCopyContext): string {
  const gate = todo.start?.gate ?? null;
  // The server clears an "after" gate when the dependency is done or dropped (evaluateGate).
  if (gate?.kind === "todo") return `On hold until ‘${gate.todo.title}’ is done or dropped. It stays out of ${possessive(agent.nestedLabel)} line until then, or until someone releases it.`;
  if (gate?.kind === "time") {
    const at = whenAt(gate.at, ctx);
    return at ? `On hold until ${at}.` : "On hold until a set time.";
  }
  if (gate?.kind === "note" && gate.note.trim()) return `On hold: ${sentenceEnd(gate.note.trim())}`;
  return "On hold until someone releases it.";
}

/** The Start now line. It says a message was sent only when something shows it was: the notice
 * outcome, or a delivery record (`receipt`), which exists only for a message that went out. */
function startNowCopy(todo: TodoVM, agent: AgentVM, ctx: TodoCopyContext): { line: string; more: string[] } {
  const name = sentenceName(agent, ctx.names);
  if (ctx.notice === "not_sent") return { line: `Moved to the front for ${name}. The message to it could not be sent.`,
    more: [`${agent.nestedLabel} sees it the next time it checks.`] };
  if (ctx.notice === "sent" || todo.receipt) return { line: `Moved to the front for ${name} and sent it a message.`,
    more: [todo.receipt, ctx.receive].filter((text): text is string => !!text) };
  return { line: `Moved to the front for ${name}.`, more: [] };
}

/** Who a request went to: the person assignee, or the agent's owner. It goes through `names`
 * by id (UI-SPEC 2.3), so two people who share a first name keep their full names here too;
 * `request.ownerFirstName` is the fallback when the id is not in `names`. */
function requestOwner(todo: TodoVM, ctx: TodoCopyContext): string {
  const assignee = todo.assignee;
  const fallback = todo.request?.ownerFirstName ?? "";
  if (assignee?.kind === "person") return personName(assignee.person, ctx.names);
  const ownerId = assignee?.kind === "agent" ? assignee.agent.ownerId : null;
  return (ownerId && ctx.names?.get(ownerId)) || fallback;
}
/** "your Claude’s" for the viewer's own agent; "Muse’s" for someone else's, so the owner's
 * possessive is never doubled ("Nikki’s Muse’s"). */
const linePossessive = (agent: AgentVM, ctx: TodoCopyContext) => possessive(agent.yours ? sentenceName(agent, ctx.names) : agent.nestedLabel);

/** The status line under "Assigned to" (UI-SPEC 3.1 to-do table). `more` lines follow it;
 * `warning` is the fix for a disconnected agent assignee and renders as a warning notice. It
 * applies to every open state of an agent's to-do (in line, Doing, on hold, a pending request),
 * because nothing moves for any of them until the agent reconnects. */
export function todoStatus(todo: TodoVM, ctx: TodoCopyContext): TodoStatusCopy {
  const plain = (line: string, more: string[] = []): TodoStatusCopy => ({ line, more, warning: null });
  if (todo.state === "dropped") return plain("Dropped.");
  if (todo.state === "done") {
    const at = todo.doneAt ? whenStamp(todo.doneAt, ctx) : null;
    return plain(`Done${todo.doneBy ? ` by ${sentenceName(todo.doneBy, ctx.names)}` : ""}${at ? ` · ${at}` : ""}`);
  }
  const assignee = todo.assignee;
  if (!assignee) return plain(`${TODO_NOT_ASSIGNED}.`);
  const owner = requestOwner(todo, ctx);
  if (todo.request?.status === "declined") return plain(`${owner} declined. Choose someone else.`);
  if (assignee.kind === "person") {
    if (todo.request) return plain(`Sent to ${owner} as a request.`, [TODO_PEOPLE_NO_LINE]);
    const name = sentenceName(assignee.person, ctx.names);
    return plain(todo.state === "doing" ? `In Doing for ${name}.` : `Assigned to ${name}. ${TODO_PEOPLE_NO_LINE}`);
  }

  const agent = assignee.agent;
  const name = sentenceName(agent, ctx.names);
  const start = todo.start;
  let line: string; let more: string[] = []; let picksUpItself = false;
  if (todo.request) line = `Sent to ${owner} as a request. It joins ${possessive(agent.nestedLabel)} line if ${owner} accepts.`;
  else if (todo.state === "doing") line = `In Doing for ${name}.`;
  else if (!start) line = `Assigned to ${name}.`;
  else if (start.mode === "queue") {
    line = start.position ? `${ordinal(start.position)} in line for ${name}.` : `In line for ${name}.`;
    more = [`${agent.nestedLabel} picks up work from its line itself.`]; picksUpItself = true;
  } else if (start.mode === "now") ({ line, more } = startNowCopy(todo, agent, ctx));
  else if (start.mode === "gated") line = gateLine(todo, agent, ctx);
  else {
    const at = start.at ? whenAt(start.at, ctx) : null;
    line = `Joins ${linePossessive(agent, ctx)} line ${at ? `at ${at}` : "at a set time"}.`;
    more = [`${agent.nestedLabel} sees it the next time it checks.`];
  }
  if (agent.state.kind !== "disconnected") return { line, more, warning: null };
  // "picks up work from its line itself" is not true while it is disconnected, so it goes.
  return { line: `${line} ${disconnectedSentence(agent)}`, more: picksUpItself ? [] : more, warning: fixSentence(agent) };
}

/** The short subline in lists and cards: "Your Claude · 2nd in line". A disconnected agent
 * adds its state word in every open state. */
export function todoSubline(todo: TodoVM, ctx: TodoCopyContext): string {
  if (todo.state === "dropped") return "Dropped";
  if (todo.state === "done") return todo.doneBy ? `Done by ${sentenceName(todo.doneBy, ctx.names)}` : "Done";
  const assignee = todo.assignee;
  if (!assignee) return TODO_NOT_ASSIGNED;
  if (todo.request?.status === "declined") return `${requestOwner(todo, ctx)} declined`;
  const who = assignee.kind === "agent" ? assignee.agent : assignee.person;
  const name = displayName(who, ctx.names);
  const start = todo.start;
  const where = todo.request ? "sent as a request"
    : todo.state === "doing" ? "in Doing"
    : assignee.kind === "person" || !start ? null
    : start.mode === "queue" ? (start.position ? `${ordinal(start.position)} in line` : "in line")
    : start.mode === "now" ? "moved to the front"
    : start.mode === "gated" ? "on hold"
    : `joins its line ${start.at && whenAt(start.at, ctx) ? `at ${whenAt(start.at, ctx)}` : "at a set time"}`;
  const word = assignee.kind === "agent" && assignee.agent.state.kind === "disconnected" ? assignee.agent.state.word : null;
  return [name, where, word].filter(Boolean).join(" · ");
}

/** Start chips for an agent assignee. Null hides them: a person, a pending or declined request,
 * a finished to-do, sample mode, or no `may.start`. Null value = nothing preselected. */
export function todoStartChoice(todo: TodoVM): ChoiceVM<TodoStartMode> | null {
  if (todo.sample || !todo.may.start || todo.request || todo.state === "done" || todo.state === "dropped") return null;
  if (todo.assignee?.kind !== "agent") return null;
  return { name: `hm-todo-start-${todo.id}`, legend: `When should ${sentenceName(todo.assignee.agent)} pick this up?`,
    value: todo.start?.mode ?? null, options: START_ORDER.map((value) => ({ value, label: TODO_START_LABELS[value] })) };
}

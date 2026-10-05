// Home UI view models (UI-owned). Frozen by UI-SPEC.md section 2.1 (lane/home-ui, 2026-10-05).
// The integration layer (home-map.ts) maps server data into these; builders never see wire types.
export type Id = string; export type Tint = 0 | 1 | 2 | 3;
export interface PersonVM { id: Id; name: string; firstName: string; initials: string; you: boolean;
  role: "owner" | "admin" | "member"; dashed?: boolean /* invited, not joined */ }
export type AgentStateKind = "working" | "idle" | "disconnected";
export interface AgentStateVM { kind: AgentStateKind; word: "Working" | "Idle" | "Disconnected" | "Not picking up";
  detail: string /* what was measured, with when */; attention: boolean;
  fix: { action: "resume" | "new-key" | "guide-chat" | "guide-local" | null; allowed: boolean; askWho: string | null; sentence: string } }
export interface AgentVM { id: Id; name: string; label: string /* section 2.3 */; nestedLabel: string; ownerId: Id | null;
  ownerFirstName: string | null; ownerInitial: string; yours: boolean; tint: Tint; hosted: boolean; state: AgentStateVM; dashed?: boolean }
export interface CapsuleVM { person: PersonVM; agents: AgentVM[] }
export interface RailVM { sample: boolean; catchUp: { href: string; current: boolean; needsYou: number | null };
  workspaces: { id: Id; name: string; href: string; current: boolean; needsYou: number | null }[];
  people: { title: string; groups: CapsuleVM[]; other: AgentVM[] } | null }
export interface ObjectCardVM { kind: "todo" | "list" | "doc" | "file"; id: Id; title: string; href: string; meta: string;
  who: PersonVM | AgentVM | null; done?: boolean }
export interface NeedsYouVM { id: Id; kind: "ask" | "agent-fix" | "todo" | "request"; workspace: { id: Id; name: string; href: string };
  from: PersonVM | AgentVM; what: string; when: string; primary: { label: string; href?: string; action?: string };
  secondary?: { label: string; href?: string; action?: string } }
export interface ChoiceVM<V extends string> { name: string; legend: string; value: V | null;
  options: { value: V; label: string; hint?: string; disabled?: boolean }[] }
export interface SwitchRowVM { id: Id; label: string; detail: string; state: "on" | "off" | "always" | "never"; busy?: boolean; disabled?: boolean }
export type Assignee = { kind: "person"; person: PersonVM } | { kind: "agent"; agent: AgentVM } | null;
export type Gate = { kind: "todo"; todo: { id: Id; title: string; href: string; done: boolean } } | { kind: "time"; at: string } | { kind: "note"; note: string };
export interface TodoVM { id: Id; workspaceId: Id; title: string; notes: string; state: "open" | "doing" | "done";
  addedBy: PersonVM | AgentVM; addedAt: string; due: string | null; assignee: Assignee;
  start: { mode: "queue" | "now" | "gated" | "at"; position: number | null; gate: Gate | null; at: string | null } | null;
  request: { status: "pending" | "declined"; ownerFirstName: string } | null;
  doneBy: PersonVM | AgentVM | null; doneAt: string | null; receipt: string | null; sample: boolean;
  may: { edit: boolean; assign: boolean; start: boolean; reorder: boolean; complete: boolean; comment: boolean };
  comments: { id: Id; author: PersonVM | AgentVM; at: string; body: string; tags: { id: Id; label: string }[] }[]; tagDelivers: boolean }
export interface QueueRowVM { todoId: Id; position: number; title: string; href: string; meta: string;
  may: { up: boolean; down: boolean; startNow: boolean; notYet: boolean; release: boolean } }
export interface PickOptionVM { value: Id; kind: "person" | "agent"; label: string; caption: string; group: Id; disabled: boolean }

import type { Tint } from "./home-types";
import { IDENTITY_LABEL_SEPARATOR } from "./identity-label";

export interface NamedPerson { id: string; name: string; firstName?: string }
export interface AgentLabelInput {
  name: string;
  ownerId?: string | null;
  ownerName?: string | null;
  ownerFirstName?: string | null;
  yours?: boolean;
  own?: boolean;
  removed?: boolean;
  ownerLeft?: boolean;
}

/** Resolve first names once per roster; shared first names use full display names. */
export function firstNames(people: readonly NamedPerson[]): Map<string, string> {
  const first = (p: NamedPerson) => p.firstName?.trim() || p.name.trim().split(/\s+/)[0] || "";
  const counts = new Map<string, number>();
  for (const p of people) {
    const key = first(p).toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map(people.map(p => [p.id, (counts.get(first(p).toLocaleLowerCase()) ?? 0) > 1 ? p.name.trim() : first(p)]));
}

/** Pass the identityDisplayLabel result as name so its duplicate-id suffix stays intact. */
export function agentLabel(agent: AgentLabelInput, opts: { nested?: boolean; people?: readonly NamedPerson[] } = {}): string {
  const name = agent.name.trim();
  const marked = (marker: string) => name.endsWith(marker) || name.includes(`${marker}${IDENTITY_LABEL_SEPARATOR}`);
  if (agent.removed || marked("(removed)")) return marked("(removed)") ? name : `${name} (removed)`;
  if (agent.ownerLeft || agent.ownerId === null) {
    return marked("(owner left)") ? name : `${name} (owner left)`;
  }
  if (opts.nested) return name;
  const owner = (agent.ownerId && opts.people ? firstNames(opts.people).get(agent.ownerId) : null)
    || agent.ownerFirstName?.trim() || agent.ownerName?.trim().split(/\s+/)[0] || "";
  // Accept the straight apostrophe from an existing identity, but show typographic punctuation.
  const owners = [owner, agent.ownerName?.trim().split(/\s+/)[0]].filter(Boolean) as string[];
  for (const prefix of owners) {
    for (const apostrophe of ["’", "'"]) {
      const possessive = `${prefix}${apostrophe}s `;
      if (name.toLocaleLowerCase().startsWith(possessive.toLocaleLowerCase())) return `${owner || prefix}’s ${name.slice(possessive.length)}`;
    }
  }
  if (/^your\s/iu.test(name)) return name;
  return agent.yours || agent.own ? `Your ${name}` : owner ? `${owner}’s ${name}` : name;
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map(part => Array.from(part)[0] ?? "").join("").toLocaleUpperCase();
}

/** FNV-1a, folded before selecting one of four site hues. */
export function agentTint(id: string): Tint {
  let hash = 2166136261;
  for (const char of id) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  return ((hash ^ (hash >>> 16)) >>> 0) % 4 as Tint;
}

export function ordinal(value: number): string {
  const n = Math.abs(Math.trunc(value));
  const lastTwo = n % 100;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${value}${suffix}`;
}

/** Local calendar days, rather than elapsed 24-hour windows (including daylight saving). */
export function formatWhen(iso: string, now: Date | number, locale = "en-US"): string {
  const date = new Date(iso), clock = new Date(now);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(clock.getTime())) return "Time unavailable";
  const time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }).replace(/\u202f/gu, " ").replace(/\b(AM|PM)\b/gu, value => value.toLowerCase());
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = (day(clock) - day(date)) / 86_400_000;
  if (days === 0) return time;
  if (days === 1) return `Yesterday, ${time}`;
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", ...(date.getFullYear() !== clock.getFullYear() ? { year: "numeric" } : {}) };
  return `${date.toLocaleDateString(locale, options)}, ${time}`;
}

export function greeting(now: Date | number): string {
  const hour = new Date(now).getHours();
  if (!Number.isFinite(hour)) return "Hello";
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

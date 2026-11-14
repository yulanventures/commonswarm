/*
 * Who can see a new channel: everyone in the workspace, or only the people and agents chosen here.
 * The one failure that matters is a channel meant to be private being created open, so the request is
 * built from this control's state by one pure function, and a state it cannot read sends nothing.
 */
import { CHANNEL_MEMBER_MAX, type ChannelVisibility } from "../../../supabase/functions/_shared/channels.js";

export const CHANNEL_AUDIENCE_TITLE = "Who can see it";
export const CHANNEL_AUDIENCE_LABELS: Record<ChannelVisibility, string> = {
  open: "Everyone in workspace",
  private: "Selected people & agents",
};
export const CHANNEL_AUDIENCE_SEARCH_LABEL = "Search people and agents";
export const CHANNEL_AUDIENCE_UNREADABLE = "Choose who can see this channel.";
export const CHANNEL_AUDIENCE_NOT_CONFIRMED = "CommonSwarm made the channel but did not confirm it is private. Check its lock before posting in it.";
/** The most people and agents a create may name; the server's own limit. */
export const CHANNEL_AUDIENCE_MAX = CHANNEL_MEMBER_MAX;

/** Someone who can be added: a person, or an agent. An agent is its own choice; it never comes with its owner. */
export interface AudienceCandidate { kind: "user" | "agent"; id: string; name: string; detail?: string }
export interface AudienceMember { kind: "user" | "agent"; id: string }

/** What `channel_create` must carry for this choice. Open sends neither key: the server refuses `members` there. */
export type ChannelCreateAudience = Record<string, never> | { visibility: "private"; members: AudienceMember[] };

const memberKey = (member: AudienceMember): string => `${member.kind}:${member.id}`;

/**
 * The request fields for a chosen audience, or `null` when the choice cannot be read. `null` must stop the
 * create: an unreadable choice is never treated as open, and never as private with nobody.
 * `chosen` is filtered to people who are still candidates, so someone who left the workspace while the
 * dialog was open is not sent.
 */
export const channelCreateAudience = (
  visibility: unknown,
  chosen: readonly AudienceMember[],
  candidates: readonly AudienceCandidate[],
): ChannelCreateAudience | null => {
  if (visibility === "open") return {};
  if (visibility !== "private") return null;
  const known = new Set(candidates.map(memberKey));
  const seen = new Set<string>();
  const members: AudienceMember[] = [];
  for (const member of chosen) {
    const key = memberKey(member);
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    members.push({ kind: member.kind, id: member.id });
  }
  return members.length > CHANNEL_AUDIENCE_MAX ? null : { visibility: "private", members };
};

/** Whether the server's answer matches what was asked. A private request must come back private. */
export const createdAsRequested = (requested: ChannelCreateAudience, created: { visibility?: unknown }): boolean =>
  !("visibility" in requested) || created.visibility === "private";

/** Candidates whose name or detail contains every word typed. */
export const filterAudience = (candidates: readonly AudienceCandidate[], query: string): AudienceCandidate[] => {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...candidates];
  return candidates.filter((candidate) => {
    const text = `${candidate.name} ${candidate.detail ?? ""}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
};

export interface ChannelAudienceControl {
  /** The request fields for the current choice; `null` when it cannot be read. */
  audience(): ChannelCreateAudience | null;
  /** Holds every control while a create is being sent. */
  hold(held: boolean): void;
}

/**
 * Draws the choice and, for a private channel, the list to choose from. Open is the default, as it is on the
 * server. Switching to open and back keeps the selection; the dialog owns when it is thrown away.
 */
export function renderChannelAudience(root: HTMLElement, candidates: readonly AudienceCandidate[]): ChannelAudienceControl {
  const doc = root.ownerDocument;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const group = make("div", "cm-audience");
  group.setAttribute("role", "radiogroup");
  const title = make("p", "cm-audience__title", CHANNEL_AUDIENCE_TITLE);
  title.id = "dashboard-channel-audience-title";
  group.setAttribute("aria-labelledby", title.id);

  const radios = new Map<ChannelVisibility, HTMLInputElement>();
  const picker = make("div", "cm-audience__picker");
  picker.dataset.channelAudiencePicker = "";
  const choices = (["open", "private"] as const).map((value) => {
    const label = make("label", "cm-audience__choice");
    const input = make("input", "cm-audience__radio");
    input.type = "radio"; input.name = "channel-audience"; input.value = value;
    input.dataset.channelAudience = value;
    input.checked = value === "open";
    input.addEventListener("change", () => { picker.hidden = !(radios.get("private")?.checked ?? false); });
    radios.set(value, input);
    label.append(input, make("span", "", CHANNEL_AUDIENCE_LABELS[value]));
    return label;
  });

  const search = make("input", "cm-audience__search");
  search.type = "search"; search.autocomplete = "off"; search.placeholder = CHANNEL_AUDIENCE_SEARCH_LABEL;
  search.setAttribute("aria-label", CHANNEL_AUDIENCE_SEARCH_LABEL);
  search.dataset.channelAudienceSearch = "";
  // The field sits inside the create form: Enter here must narrow the list, never create the channel.
  search.addEventListener("keydown", (event) => { if (event.key === "Enter") event.preventDefault(); });
  const list = make("div", "cm-audience__list");
  list.dataset.channelAudienceList = "";
  const count = make("p", "cm-audience__count");
  count.setAttribute("role", "status");
  count.dataset.channelAudienceCount = "";

  const chosen = new Map<string, AudienceMember>();
  const boxes: HTMLInputElement[] = [];
  let held = false;
  const syncCount = (): void => {
    count.textContent = chosen.size === 0 ? "" : `${chosen.size} selected`;
    const full = chosen.size >= CHANNEL_AUDIENCE_MAX;
    for (const box of boxes) box.disabled = held || (full && !box.checked);
  };
  const draw = (): void => {
    boxes.length = 0;
    const shown = filterAudience(candidates, search.value);
    const sections = ([["user", "People"], ["agent", "Agents"]] as const).flatMap(([kind, heading]) => {
      const rows = shown.filter((candidate) => candidate.kind === kind);
      if (rows.length === 0) return [];
      const section = make("div", "cm-audience__section");
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", heading);
      section.append(make("p", "cm-audience__heading", heading));
      for (const candidate of rows) {
        const key = memberKey(candidate);
        const row = make("label", "cm-audience__row");
        const box = make("input", "cm-audience__box");
        box.type = "checkbox"; box.checked = chosen.has(key);
        box.dataset.channelAudienceMember = key;
        box.addEventListener("change", () => {
          if (box.checked) chosen.set(key, { kind: candidate.kind, id: candidate.id }); else chosen.delete(key);
          syncCount();
        });
        boxes.push(box);
        const copy = make("span", "cm-audience__name", candidate.name);
        row.append(box, copy);
        if (candidate.detail) row.append(make("span", "cm-audience__detail", candidate.detail));
        section.append(row);
      }
      return [section];
    });
    list.replaceChildren(...(sections.length > 0 ? sections : [make("p", "cm-audience__empty", "No one matches")]));
    syncCount();
  };
  search.addEventListener("input", draw);

  picker.hidden = true;
  picker.append(search, list, count);
  group.append(title, ...choices, picker);
  root.replaceChildren(group);
  draw();

  return {
    audience() {
      const picked = [...radios].filter(([, input]) => input.checked).map(([value]) => value);
      return channelCreateAudience(picked.length === 1 ? picked[0] : undefined, [...chosen.values()], candidates);
    },
    hold(next) {
      held = next;
      for (const input of radios.values()) input.disabled = next;
      search.disabled = next;
      syncCount();
    },
  };
}

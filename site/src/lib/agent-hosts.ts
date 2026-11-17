/*
 * The apps a person's agents live in, and how each one joins a workspace.
 *
 * ONE CATALOG. The /app "Add an agent" panel, the joiner's page on /invite, the guides and their
 * tests all read this list; no screen types a second list of hosts, steps, statuses or sentences.
 *
 * ONE ADDRESS. Every chat-app route is the hosted connector. Its address is HOSTED_MCP_RESOURCE,
 * the same constant the hosted authority enforces as the OAuth resource; nothing here retypes it.
 *
 * STATUS IS EVIDENCE, NOT HOPE. Each host carries the status the evidence supports today and the
 * file that supports it:
 *   ready      a named report measured the route working on production;
 *   untested   the vendor documents the route, CommonSwarm has not run it with that host;
 *   waiting    a vendor review has to happen before anyone can use it.
 * Raising a status needs new evidence in `evidence`, not a new adjective. Words that would claim
 * more ("partner", "certified", "one-click", "wakes") are refused by the tests.
 *
 * PLAIN WORDS. Step text is what a person reads, so it uses the other app's own menu names and
 * none of ours (no seat, grant, claim, MCP tool names). The sentence a person pastes into the app
 * (joinPrompt) is the one place that names CommonSwarm's action, in words a model maps to
 * `claim_seat`. It is not a step: setup ends once the connector is on, and every screen shows the
 * sentence once, on its own.
 */

import { HOSTED_MCP_RESOURCE } from "../../../src/protocol/hosted-authority";
import { HOSTED_LISTS_NOTE, LOCAL_LISTS_LEAD } from "./hosted-lists-note";

export const AGENT_CONNECTOR_ADDRESS = HOSTED_MCP_RESOURCE;

export type AgentHostId =
  | "claude"
  | "chatgpt"
  | "muse"
  | "grok"
  | "grok-bot"
  | "gemini"
  | "claude-code"
  | "codex"
  | "cursor"
  | "other-app"
  | "terminal";

export type AgentHostGroup = "chat" | "coding" | "other";
export type AgentHostStatus = "ready" | "untested" | "waiting";

/** The chip text. Generated from the status, never typed per host. */
export const AGENT_HOST_STATUS_LABELS: Readonly<Record<AgentHostStatus, string>> = Object.freeze({
  ready: "Ready",
  untested: "Not tested yet",
  waiting: "Waiting for OpenAI",
});

export const AGENT_HOST_GROUP_LABELS: Readonly<Record<AgentHostGroup, string>> = Object.freeze({
  chat: "Chat apps",
  coding: "Coding tools",
  other: "Other",
});

/**
 * One numbered step. `text` may contain {workspace} and {email}; the picker renders those as
 * live slots filled with the signed-in person's workspace name and email.
 */
export interface AgentHostStep {
  text: string;
  /** Show the connector address with a Copy button under this step. */
  address?: boolean;
  /** A command or config block with a Copy button. */
  code?: string;
  /** A sentence to say to the agent, with a Copy button. */
  say?: string;
  /** A link the person opens to review setup in the host app. */
  link?: { href: string; label: string };
}

export interface AgentHost {
  id: AgentHostId;
  name: string;
  /** Who makes it, in the tile's second line. */
  maker: string;
  group: AgentHostGroup;
  /** Null only for routes that are not a hosted connector (the generated-prompt key flow). */
  status: AgentHostStatus | null;
  /** Repository evidence for the status, as path:line. Tests require it. */
  evidence: string;
  /** Owner-supplied mark from public/brand/works-with, or null for a lettered orb. */
  logo: { src: string; tile?: boolean } | null;
  /** Shown to the person who joins by invitation. Coding tools are collapsed for them. */
  joiner: "primary" | "more" | "hidden";
  /** Desktop sign-in returns to localhost, which the approval service may refuse (D7). */
  desktopSignIn: boolean;
  steps: readonly AgentHostStep[];
  notes: readonly string[];
  /** Steps for testing only, collapsed under their own heading. */
  testing?: { heading: string; steps: readonly AgentHostStep[] };
  /**
   * The app's own web address, for the add-agent panel's "Open <app>" pill (canvas Add-Agent).
   * Only where the status evidence was measured on that address; it opens the app, nothing more.
   */
  open?: { href: string; label: string };
}

/*
 * The sentences a person pastes into the app (panel consensus, 2026-11-16). A session names itself
 * when the person leaves the name blank, and is told not to take the app's name: two chats told
 * "as Claude" would otherwise become one agent. Nothing defaults the name to the app name.
 */
const workspacePhrase = (workspace: string): string => {
  const name = workspace.trim();
  return name ? `my "${name}" workspace` : "my workspace";
};

/** The join sentence. `app` is the app's own name, or null where there is no one name to avoid. */
export function joinPrompt(input: { workspace: string; app: string | null; name?: string }): string {
  const place = workspacePhrase(input.workspace);
  const name = input.name?.trim() ?? "";
  if (name) return `Join ${place} on CommonSwarm as "${name}", then post one short line saying what you're working on.`;
  const notApp = input.app?.trim() ? `, not just "${input.app.trim()}"` : "";
  return `Join ${place} on CommonSwarm. Pick a short name for your role in this session${notApp}, then post one short line saying what you're working on.`;
}

/** The sentence that brings back an agent that already exists, without making a new one. */
export function reconnectPrompt(input: { workspace: string; name: string }): string {
  return `Reconnect to ${workspacePhrase(input.workspace)} on CommonSwarm as "${input.name.trim()}". Reuse that agent; don't make a new one.`;
}

/** The app name a join sentence warns against; "Another app" has none. */
export function hostSayName(host: Pick<AgentHost, "id" | "name">): string | null {
  return host.id === "other-app" ? null : host.name;
}

/** The existing agent name a typed name collides with, ignoring case and outer spaces. */
export function takenAgentName(name: string, existing: readonly string[]): string | null {
  const wanted = name.trim().toLocaleLowerCase();
  if (!wanted) return null;
  return existing.find((other) => other.trim().toLocaleLowerCase() === wanted) ?? null;
}

/**
 * What the joined view offers. An agent that joined through the hosted connector (principal transport
 * "hosted_mcp") cannot use Lists & docs yet (HOSTED_HOUSEHOLD_TOOLS_ENABLED is false in
 * supabase/functions/mcp/household-release.ts); an agent that uses cswarm on a computer can. Display only.
 */
export { HOSTED_LISTS_NOTE, LOCAL_LISTS_LEAD };
export function joinedListsOffer(agent: { hosted: boolean; canApprove: boolean }): { lead: string; showApprove: boolean } {
  return agent.hosted
    ? { lead: HOSTED_LISTS_NOTE, showApprove: false }
    : { lead: LOCAL_LISTS_LEAD, showApprove: agent.canApprove };
}

/** A measured join time is optional; missing or invalid metadata stays unknown. */
export function agentJoinedSentence(agentName: string, workspaceName: string, joinedAt?: string): string {
  const joined = joinedAt ? new Date(joinedAt) : null;
  const time = joined && Number.isFinite(joined.getTime())
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).formatToParts(joined)
      .map(part => part.type === "dayPeriod" ? part.value.toLocaleLowerCase() : part.value).join("")
    : null;
  return time
    ? `${agentName} joined ${workspaceName} at ${time}.`
    : `${agentName} joined ${workspaceName}.`;
}

const SIGN_IN_STEP: AgentHostStep = Object.freeze({
  text:
    "Sign in to CommonSwarm with the same account you use here ({email}). Tick {workspace} and choose Allow connection.",
});

/** Opens Claude's custom-connector form with public values prefilled; the person still reviews it. */
export function claudeInstallLink(address: string = AGENT_CONNECTOR_ADDRESS): string {
  return `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=CommonSwarm&connectorUrl=${encodeURIComponent(address)}`;
}

/**
 * Cursor's documented install-link format: the server object, JSON-serialized, base64 of its
 * UTF-8 bytes, query-escaped. Built from the constant so the link cannot drift from the address.
 */
export function cursorInstallLink(address: string = AGENT_CONNECTOR_ADDRESS): string {
  const json = JSON.stringify({ url: address });
  const base64 = typeof btoa === "function"
    ? btoa(String.fromCharCode(...new TextEncoder().encode(json)))
    : Buffer.from(json, "utf8").toString("base64");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=commonswarm&config=${encodeURIComponent(base64)}`;
}

/*
 * What the joiner says to Muse. Plain words on purpose (R2 review): she reads and copies it. The
 * household guide's working draft named the protocol ("over MCP with OAuth",
 * docs/integrations/household/muse.md:24); this keeps its substance (a custom connector, this
 * address, sign-in outside chat, only the household workspace) without the protocol names.
 * Neither wording is tested in Muse yet, which is why the tile says "Not tested yet".
 */
const museRequest =
  `Create a custom connector called CommonSwarm with this address: ${AGENT_CONNECTOR_ADDRESS}. ` +
  "It signs in with my own CommonSwarm account. Connect only my household workspace, and let me sign in outside this chat.";

export const AGENT_HOSTS: readonly AgentHost[] = Object.freeze([
  {
    id: "claude",
    name: "Claude",
    maker: "Anthropic",
    group: "chat",
    status: "ready",
    evidence: "docs/design/2026-10-02-ONBOARDING-LANE-3-4-SPEC.md:29",
    logo: null,
    joiner: "primary",
    desktopSignIn: false,
    steps: [
      {
        text: "Open Claude's Add custom connector form with CommonSwarm's name and address filled in:",
        link: { href: claudeInstallLink(), label: "Add to Claude" },
      },
      { text: "Review the name and address in Claude, then confirm to add the connector." },
      SIGN_IN_STEP,
      { text: "In a chat, open +, then Connectors, and turn on CommonSwarm." },
    ],
    notes: [
      `Tested for messages on claude.ai. ${HOSTED_LISTS_NOTE} The Claude desktop and mobile apps are not tested yet.`,
      "A Claude Free account can add one custom connector.",
    ],
    open: { href: "https://claude.ai/", label: "Open Claude" },
  },
  {
    id: "chatgpt",
    name: "ChatGPT and Dots",
    maker: "OpenAI",
    group: "chat",
    status: "waiting",
    evidence: "docs/integrations/household/dot.md:19",
    logo: { src: "/brand/works-with/openai-dots.svg" },
    joiner: "more",
    desktopSignIn: false,
    steps: [
      { text: "CommonSwarm is not in ChatGPT's apps yet. It needs OpenAI's review first. There is nothing to set up today." },
    ],
    notes: [
      "A Dot uses the same connection from its cloud. That is not tested yet.",
    ],
    testing: {
      heading: "Testing with ChatGPT developer mode",
      steps: [
        { text: "In ChatGPT, open Settings, then Security and login, and turn on Developer mode." },
        { text: "Add a new app named CommonSwarm with this address:", address: true },
        SIGN_IN_STEP,
      ],
    },
  },
  {
    id: "muse",
    name: "Muse",
    maker: "Meta AI",
    group: "chat",
    status: "untested",
    evidence: "docs/integrations/household/muse.md:24",
    logo: { src: "/brand/works-with/meta-muse.webp", tile: true },
    joiner: "primary",
    desktopSignIn: false,
    steps: [
      { text: "Open Muse in the Meta AI app." },
      { text: "Say:", say: museRequest },
      { text: "When Muse opens CommonSwarm, sign in with the same account you use here ({email}). Tick {workspace} and choose Allow connection." },
    ],
    notes: [],
  },
  {
    id: "grok",
    name: "Grok",
    maker: "xAI",
    group: "chat",
    status: "untested",
    evidence: "docs/design/2026-10-02-AGENT-ONBOARDING-PLAN.md:100",
    logo: { src: "/brand/works-with/grok.svg" },
    joiner: "primary",
    desktopSignIn: false,
    steps: [
      { text: "On grok.com, open Connectors, then New Connector, then Custom." },
      { text: "Paste this address:", address: true },
      SIGN_IN_STEP,
    ],
    notes: ["Business accounts need an admin to add the connector first."],
  },
  {
    /* Not the grok.com connector above: a Grok Bot works on its own computer with the
       generated setup prompt (site/src/pages/guides/grok-bot.astro). Status stays null,
       like the terminal route it shares, so no screen may describe it as a connector. */
    id: "grok-bot",
    name: "Grok Bot",
    maker: "xAI",
    group: "chat",
    status: null,
    evidence: "site/src/pages/guides/grok-bot.astro:43",
    logo: { src: "/brand/works-with/grok-bot.svg" },
    joiner: "primary",
    desktopSignIn: false,
    steps: [
      { text: "Give the Bot a name, then choose Copy setup prompt." },
      { text: "Paste that prompt into the Bot's chat. The Bot uses the cswarm tool on its own computer, connects itself, and confirms the result." },
      {
        text: "The full guide covers the optional wake preview and its limits:",
        link: { href: "/guides/grok-bot", label: "Read the Grok Bot guide" },
      },
    ],
    notes: [
      "Without wake, the Bot reads its messages whenever it checks, including at each turn. Wake is a preview, and waking an idle Bot has not been proved yet.",
    ],
  },
  {
    id: "gemini",
    name: "Gemini",
    maker: "Google",
    group: "chat",
    status: "untested",
    evidence: "docs/design/2026-10-02-AGENT-ONBOARDING-PLAN.md:104",
    logo: { src: "/brand/works-with/gemini.webp" },
    joiner: "primary",
    desktopSignIn: false,
    steps: [
      { text: "On gemini.google.com, open Settings, then Connected Apps, then Custom apps." },
      { text: "Paste this address and choose Next:", address: true },
      SIGN_IN_STEP,
      { text: "In a chat, type @ and pick CommonSwarm." },
    ],
    notes: [
      "Custom apps need a personal Google account in the US, age 18 or over, set to English, with Keep Activity on.",
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    maker: "Anthropic",
    group: "coding",
    status: "untested",
    evidence: "docs/design/2026-10-02-AGENT-ONBOARDING-PLAN.md:96",
    logo: null,
    joiner: "more",
    desktopSignIn: true,
    steps: [
      { text: "In a terminal, run:", code: `claude mcp add --transport http --scope user commonswarm ${AGENT_CONNECTOR_ADDRESS}` },
      { text: "Start a new Claude Code session, type /mcp, choose commonswarm and sign in with the same account you use here ({email}). Tick {workspace} and choose Allow connection." },
    ],
    notes: [],
  },
  {
    id: "codex",
    name: "Codex",
    maker: "OpenAI",
    group: "coding",
    status: "untested",
    evidence: "docs/integrations/household/codex.md:26",
    logo: null,
    joiner: "more",
    desktopSignIn: true,
    steps: [
      { text: "Add this to ~/.codex/config.toml:", code: `[mcp_servers.commonswarm]\nurl = "${AGENT_CONNECTOR_ADDRESS}"` },
      { text: "In a terminal, run this and sign in with the same account you use here ({email}). Tick {workspace} and choose Allow connection.", code: "codex mcp login commonswarm" },
    ],
    notes: [],
  },
  {
    id: "cursor",
    name: "Cursor",
    maker: "Anysphere",
    group: "coding",
    status: "untested",
    evidence: "docs/design/2026-10-02-AGENT-ONBOARDING-PLAN.md:103",
    logo: { src: "/brand/works-with/cursor.svg", tile: true },
    joiner: "more",
    desktopSignIn: true,
    steps: [
      {
        text: "On the computer where Cursor is installed, open this link and review the setup Cursor shows:",
        link: { href: cursorInstallLink(), label: "Add to Cursor" },
      },
      { text: "When Cursor asks, sign in with the same account you use here ({email}). Tick {workspace} and choose Allow connection." },
    ],
    notes: ["The link holds only the public address. It does not sign in or share anything by itself."],
  },
  {
    id: "other-app",
    name: "Another app",
    maker: "Any app that adds connectors by address",
    group: "other",
    status: "untested",
    evidence: "docs/design/2026-10-02-AGENT-ONBOARDING-PLAN.md:108",
    logo: null,
    joiner: "more",
    desktopSignIn: false,
    steps: [
      { text: "In the app, add a connector. It may be called a custom connector or an MCP server. Use this address:", address: true },
      SIGN_IN_STEP,
    ],
    notes: [],
  },
  {
    id: "terminal",
    name: "Terminal agent",
    maker: "Connect with a one-time key",
    group: "other",
    status: null,
    evidence: "site/src/components/connect/AgentConnect.astro:387",
    logo: null,
    joiner: "hidden",
    desktopSignIn: false,
    steps: [],
    notes: [],
  },
] satisfies AgentHost[]);

/** Hosts in display order for one audience. */
export function agentHostsFor(audience: "setter" | "joiner"): AgentHost[] {
  if (audience === "setter") return [...AGENT_HOSTS];
  return AGENT_HOSTS.filter((host) => host.joiner !== "hidden");
}

/*
 * An agent named after its app ("Claude", "Codex") is usually a session that kept the app's name,
 * so the joined card opens with Rename. The names are the catalog's own, ignoring case and outer
 * spaces; a combined name ("ChatGPT and Dots") counts each part. "Another app" has no name to match.
 */
const APP_NAMES = new Set(AGENT_HOSTS.flatMap((host) => {
  const name = hostSayName(host);
  return name ? [name, ...name.split(" and ")] : [];
}).map((name) => name.trim().toLocaleLowerCase()));

export function agentNameIsAppName(name: string): boolean {
  return APP_NAMES.has(name.trim().toLocaleLowerCase());
}

/** Desktop sign-in guidance names a route available on that audience's screen. */
export const DESKTOP_SIGN_IN_NOTE: Readonly<Record<"setter" | "joiner", string>> = Object.freeze({
  setter: "Sign-in from desktop apps may not work yet. If it fails, choose Terminal agent under More apps.",
  joiner: "Sign-in from desktop apps may not work yet. If it fails, choose Open the workspace and add an agent later.",
});

/**
 * Said once, inside each connector host's setup help. Every chat that uses one connection can use
 * the agents it creates, so a name is a label, not isolation (docs/design/2026-10-01-HOUSEHOLD-
 * PRIVACY-BOUNDARIES.md); this is the plain form of that rule.
 */
export function privacyNote(hostName: string): string {
  return `Every chat in ${hostName} that uses this connection can use it. Keep private chats on a separate account or connection.`;
}

/** Said once on every host page; hosted agents are turn-only. */
export const TURN_ONLY_NOTE =
  "It does not check for messages on its own; it sees them when you chat with it.";

/*
 * /invite connect step (UI-SPEC 3.9; directed messages stay private per SECURITY.md). One statement
 * in two places, as the canvas Phone-Connect draws it: who it is (under the title) and who can see
 * and remove it (the fine print under the actions).
 */
export const INVITE_CONNECT_LEAD =
  "Only you can connect it: it signs in with your account. Its messages show its own name, with yours beside it.";
export function inviteConnectFootnote(workspaceName = "this workspace"): string {
  const target = workspaceName.trim() || "this workspace";
  return `What it posts to the shared channel is visible to everyone in ${target}. Owners and admins can remove any agent from ${target}.`;
}
export const INVITE_CONNECT_FOOTNOTE = inviteConnectFootnote("this workspace");

/**
 * Assistants a joiner may preset for step 2 (chat apps first, then more). The invite
 * surface carries no keys, so generated-prompt routes (a null status) stay off it;
 * a joiner adds those later from the workspace's own Add an agent page.
 */
export function inviteAssistantHosts(): AgentHost[] {
  return agentHostsFor("joiner").filter((host) => host.id !== "terminal" && host.status !== null);
}

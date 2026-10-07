/*
 * The apps a person's agents live in, and how each one joins a workspace.
 *
 * ONE CATALOG. The /app "Add an agent" picker, the joiner's page on /invite and their tests all
 * read this list; no screen types a second list of hosts, steps or statuses.
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
 * none of ours (no seat, grant, claim, MCP tool names). The sentence a person says to the agent is
 * the one place that names CommonSwarm's action, in words a model maps to `claim_seat`.
 */

import { HOSTED_MCP_RESOURCE } from "../../../src/protocol/hosted-authority";

export const AGENT_CONNECTOR_ADDRESS = HOSTED_MCP_RESOURCE;

export type AgentHostId =
  | "claude"
  | "chatgpt"
  | "muse"
  | "grok"
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
  /** A link the person opens (the Cursor install link). */
  link?: { href: string; label: string };
}

export interface AgentHost {
  id: AgentHostId;
  name: string;
  /** Who makes it, in the tile's second line. */
  maker: string;
  group: AgentHostGroup;
  /** Null only for routes that are not a hosted connector (the terminal key flow). */
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
}

/** The sentence that makes a connected agent join. Kept here so every host says the same thing. */
export function joinSentence(agentName: string): string {
  return `Use CommonSwarm to join my workspace as ${agentName}, then list who is there.`;
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
      { text: "In Claude, open Customize, then Connectors, then Add, then Add custom connector." },
      { text: "Name it CommonSwarm and paste this address:", address: true },
      SIGN_IN_STEP,
      { text: "In a chat, open +, then Connectors, and turn on CommonSwarm. Then say:", say: joinSentence("Claude") },
    ],
    notes: [
      "Tested for messages on claude.ai. Lists & docs and the Claude desktop and mobile apps are not tested yet.",
      "A Claude Free account can add one custom connector.",
    ],
  },
  {
    id: "chatgpt",
    name: "ChatGPT and Dots",
    maker: "OpenAI",
    group: "chat",
    status: "waiting",
    evidence: "docs/integrations/household/dot.md:19",
    logo: { src: "/brand/works-with/openai-dots.svg" },
    joiner: "primary",
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
        { text: "In a chat, say:", say: joinSentence("ChatGPT") },
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
      { text: "Then say:", say: joinSentence("Muse") },
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
      { text: "In a chat, say:", say: joinSentence("Grok") },
    ],
    notes: ["Business accounts need an admin to add the connector first."],
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
      { text: "In a chat, type @, pick CommonSwarm, and say:", say: joinSentence("Gemini") },
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
      { text: "In a terminal, run:", code: `claude mcp add --transport http commonswarm ${AGENT_CONNECTOR_ADDRESS}` },
      { text: "In Claude Code, type /mcp, choose commonswarm and sign in with the same account you use here ({email}). Tick {workspace} and choose Allow connection." },
      { text: "Then say:", say: joinSentence("Claude Code") },
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
      { text: "In Codex, say:", say: joinSentence("Codex") },
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
      { text: "In a Cursor chat, say:", say: joinSentence("Cursor") },
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
      { text: "Then say to the agent:", say: joinSentence("my agent") },
    ],
    notes: [],
  },
  {
    id: "terminal",
    name: "Terminal agent",
    maker: "Connect with a one-time key",
    group: "other",
    status: null,
    evidence: "site/src/components/connect/AgentConnect.astro:211",
    logo: null,
    joiner: "hidden",
    desktopSignIn: false,
    steps: [],
    notes: [],
  },
] satisfies AgentHost[]);

/**
 * The add-agent page's one-line summary of a host's route (the canvas Add-Agent connection panel).
 * It names the same three acts the numbered steps spell out; the steps stay one tap away under
 * "How to connect, step by step". A host that cannot connect yet keeps its own first step.
 */
export function hostConnectLine(host: AgentHost): string {
  if (host.status === "waiting") return host.steps[0]?.text ?? "";
  const app = host.id === "other-app" ? "the app" : host.name;
  const start = host.steps.some((step) => step.link)
    ? `Open the link to add CommonSwarm to ${app}`
    : `Add CommonSwarm in ${app}`;
  return `${start}, sign in with the account you use here, then say the sentence below. The full steps are under How to connect, step by step.`;
}

/** The sentence the add-agent page puts in its one copy block: the host's last "say" step. */
export function hostJoinPrompt(host: AgentHost): string | null {
  return [...host.steps].reverse().find((step) => step.say)?.say ?? null;
}

/** Hosts in display order for one audience. */
export function agentHostsFor(audience: "setter" | "joiner"): AgentHost[] {
  if (audience === "setter") return [...AGENT_HOSTS];
  return AGENT_HOSTS.filter((host) => host.joiner !== "hidden");
}

/** Desktop sign-in guidance names a route available on that audience's screen. */
export const DESKTOP_SIGN_IN_NOTE: Readonly<Record<"setter" | "joiner", string>> = Object.freeze({
  setter: "Sign-in from desktop apps may not work yet. If it fails, go back to Which app? and choose Terminal agent under More apps.",
  joiner: "Sign-in from desktop apps may not work yet. If it fails, choose Open the workspace and add an agent later.",
});

/**
 * Said once on every connector host page. Every chat that uses one connection can use the agents
 * it creates, so a name does not keep chats apart (docs/design/2026-10-01-HOUSEHOLD-PRIVACY-
 * BOUNDARIES.md); this is the plain form of that rule.
 */
export function privacyNote(hostName: string): string {
  return `Every chat in ${hostName} that uses this connection can use it. Keep private chats on a separate account or connection.`;
}

/** Said once on every host page; hosted agents are turn-only. */
export const TURN_ONLY_NOTE =
  "It does not check for messages on its own; it sees them when you chat with it.";

/** Said once on every host page; menu names are the vendors' documented ones. */
export const MENU_LABELS_NOTE = "Menu names come from each app's help pages and can differ in your version.";

/*
 * /invite connect step (UI-SPEC 3.9; directed messages stay private per SECURITY.md). One statement
 * in two places, as the canvas Phone-Connect draws it: who it is (under the title) and who can see
 * and remove it (the fine print under the actions).
 */
export const INVITE_CONNECT_LEAD =
  "Only you can connect it: it signs in with your account. Its messages show its own name, with yours beside it.";
export const INVITE_CONNECT_FOOTNOTE =
  "What it posts to the shared channel is visible to everyone in Home. Owners and admins can remove any agent from Home.";

/** Assistants a joiner may preset for step 2 (chat apps first, then more). */
export function inviteAssistantHosts(): AgentHost[] {
  return agentHostsFor("joiner").filter((host) => host.id !== "terminal");
}

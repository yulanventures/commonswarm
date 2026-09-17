import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cloudTarget } from "../../src/cloud/config.js";
import { encodeInviteLink, type InviteLinkPayload } from "../../src/cloud/invite-link.js";
import { credentialStore } from "../../src/cloud/storage.js";

type Fixture = {
  id: string;
  argv: string[];
  input?: string;
  env?: Record<string, string>;
  humanSession?: boolean;
};

type CommandEntryCoverage = {
  key: string;
  variants: readonly string[];
  profile: "refuse" | "native" | "expand";
  hostSessionId: "keep" | "drop";
  errorMode: "standard" | "onboarding" | "hook-check";
  workspaceErrorJson: boolean;
};

type BaselineRow = {
  id: string;
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  handlers: string[];
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(repoRoot, "src", "cli.ts");
const preloadPath = join(repoRoot, "tests", "fixtures", "dispatch-trace-preload.mjs");
const baselinePath = join(repoRoot, "tests", "p1-cli", "fixtures", "command-dispatch-baseline.json");
const baselineCountsPath = join(repoRoot, "tests", "p1-cli", "fixtures", "command-dispatch-baseline-counts.json");
const WS = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const SIGNAL_ID = "55555555-5555-4555-8555-555555555555";
const TASK_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_ID = "77777777-7777-4777-8777-777777777777";
const AGENT_TOKEN = `swm_agt_${"A".repeat(43)}`;
const INVITATION_TOKEN = `swm_inv_${"B".repeat(43)}`;
const HUMAN_USER = "88888888-8888-4888-8888-888888888888";
const HUMAN_DEVICE = "99999999-9999-4999-8999-999999999999";

/**
 * This is the mechanically enumerated shape of the old dispatcher. Commit 1
 * uses it because AGENT_COMMANDS does not exist yet. Once the conversion lands,
 * commandEntryCoverage() derives the same rows from AGENT_COMMANDS and rejects
 * any drift from this inventory.
 */
const LEGACY_COMMAND_ENTRY_COVERAGE: readonly CommandEntryCoverage[] = [
  { key: "setup", variants: ["import", "version", "guide"], profile: "native", hostSessionId: "keep", errorMode: "onboarding", workspaceErrorJson: false },
  { key: "check", variants: ["messages", "message", "hook"], profile: "native", hostSessionId: "keep", errorMode: "onboarding", workspaceErrorJson: false },
  ...["configure", "status", "test", "confirm", "idle", "serve", "refusal"].map(key => ({ key: `receive.${key}`, variants: ["default"], profile: "native" as const, hostSessionId: "keep" as const, errorMode: "onboarding" as const, workspaceErrorJson: false })),
  { key: "__listen-supervisor", variants: ["default"], profile: "refuse", hostSessionId: "drop", errorMode: "standard", workspaceErrorJson: false },
  ...["check", "install", "uninstall"].map(key => ({ key: `hook.${key}`, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: key === "check" ? "hook-check" as const : "standard" as const, workspaceErrorJson: false })),
  { key: "hook.refusal", variants: ["default"], profile: "refuse", hostSessionId: "drop", errorMode: "standard", workspaceErrorJson: false },
  ...["start", "status", "stop", "canary", "refusal"].map(key => ({ key: `listen.${key}`, variants: ["default"], profile: "expand" as const, hostSessionId: "keep" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  ...["start", "status", "stop", "enable", "disable", "recover", "refusal"].map(key => ({ key: `session.${key}`, variants: ["default"], profile: "expand" as const, hostSessionId: "keep" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  ...["login", "logout"].map(key => ({ key, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  ...["create", "revoke", "refusal"].map(key => ({ key: `invite.${key}`, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  ...["remove", "refusal"].map(key => ({ key: `member.${key}`, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  ...["close", "refusal"].map(key => ({ key: `workspace.${key}`, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  ...["show", "set", "clear", "refusal"].map(key => ({ key: `target.${key}`, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  { key: "status", variants: ["default"], profile: "refuse", hostSessionId: "drop", errorMode: "standard", workspaceErrorJson: true },
  { key: "whoami", variants: ["default"], profile: "expand", hostSessionId: "drop", errorMode: "standard", workspaceErrorJson: false },
  { key: "resume", variants: ["inspect", "profile"], profile: "native", hostSessionId: "keep", errorMode: "standard", workspaceErrorJson: false },
  { key: "feedback", variants: ["default"], profile: "expand", hostSessionId: "drop", errorMode: "standard", workspaceErrorJson: false },
  ...["create", "ls", "rename", "archive", "refusal"].map(key => ({ key: `channel.${key}`, variants: ["default"], profile: "expand" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  ...["put", "ls", "get", "rm", "restore"].map(key => ({ key: `file.${key}`, variants: ["default"], profile: "expand" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: true })),
  { key: "file.refusal", variants: ["default"], profile: "expand", hostSessionId: "drop", errorMode: "standard", workspaceErrorJson: false },
  ...["ls", "get", "put"].map(key => ({ key: `brain.${key}`, variants: ["default"], profile: "expand" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: true })),
  { key: "brain.refusal", variants: ["default"], profile: "expand", hostSessionId: "drop", errorMode: "standard", workspaceErrorJson: false },
  { key: "members", variants: ["default"], profile: "expand", hostSessionId: "drop", errorMode: "standard", workspaceErrorJson: false },
  ...["working-on", "note", "ask", "reply", "receipt", "feed"].map(key => ({ key, variants: ["default"], profile: "expand" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: true })),
  { key: "inbox", variants: ["read", "notify", "follow"], profile: "expand", hostSessionId: "drop", errorMode: "standard", workspaceErrorJson: true },
  ...["workspaces", "use"].map(key => ({ key, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: true })),
  ...["new"].map(key => ({ key, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  { key: "accept", variants: ["linkStdin", "legacyStdin", "positional"], profile: "refuse", hostSessionId: "drop", errorMode: "standard", workspaceErrorJson: false },
  ...["create", "revoke", "refusal"].map(key => ({ key: `principal.${key}`, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  ...["mint", "revoke", "refusal"].map(key => ({ key: `token.${key}`, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  ...["resume", "refusal"].map(key => ({ key: `grant.${key}`, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  ...["new", "revoke", "refusal"].map(key => ({ key: `link.${key}`, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
  ...["command", "dogfood", "seed-fixture"].map(key => ({ key, variants: ["default"], profile: "refuse" as const, hostSessionId: "drop" as const, errorMode: "standard" as const, workspaceErrorJson: false })),
];

async function commandEntryCoverage(): Promise<readonly CommandEntryCoverage[]> {
  const cli = await import("../../src/cli.js") as {
    AGENT_COMMANDS?: Record<string, {
      variants?: Record<string, unknown>;
      profile?: CommandEntryCoverage["profile"];
      hostSessionId?: CommandEntryCoverage["hostSessionId"];
      errorMode?: CommandEntryCoverage["errorMode"];
      workspaceErrorJson?: boolean;
      subcommands?: Record<string, unknown>;
      refusal?: unknown;
    }>;
  };
  const ordered = (rows: readonly CommandEntryCoverage[]) =>
    [...rows].sort((left, right) => left.key.localeCompare(right.key));
  // Commit 1 recorded this inventory before the table existed. Now the table must be exported: a missing or renamed
  // export fails here instead of silently comparing the inventory with itself.
  assert.ok(cli.AGENT_COMMANDS, "AGENT_COMMANDS must be exported from src/cli.ts");
  const result: CommandEntryCoverage[] = [];
  const add = (key: string, raw: unknown) => {
    const entry = raw as Omit<CommandEntryCoverage, "key" | "variants"> & { variants: Record<string, unknown> };
    result.push({
      key,
      variants: Object.keys(entry.variants),
      profile: entry.profile,
      hostSessionId: entry.hostSessionId,
      errorMode: entry.errorMode,
      workspaceErrorJson: entry.workspaceErrorJson,
    });
  };
  for (const [verb, root] of Object.entries(cli.AGENT_COMMANDS)) {
    if (root.subcommands === undefined) {
      add(verb, root);
      continue;
    }
    for (const [action, entry] of Object.entries(root.subcommands)) add(`${verb}.${action}`, entry);
    add(`${verb}.refusal`, root.refusal);
  }
  const actual = ordered(result);
  assert.deepEqual(actual, ordered(LEGACY_COMMAND_ENTRY_COVERAGE), "the table changed without updating baseline coverage");
  return actual;
}

/**
 * Closed sub-action selectors found by enumerating the old dispatcher and its
 * delegated handlers on 1cc1a663. The matrix below is generated from this
 * inventory so every selector gets the same missing/unknown, JSON, and profile
 * refusal coverage.
 */
const GROUP_REFUSAL_SITES = [
  "receive",
  "hook",
  "listen",
  "session",
  "invite",
  "member",
  "workspace",
  "target",
  "channel",
  "file",
  "brain",
  "principal",
  "token",
  "grant",
  "link",
] as const;

const GROUP_REFUSAL_AXES = [
  { id: "plain", argv: [] },
  { id: "json", argv: ["--json"] },
  { id: "profile-valid", argv: ["--profile", "<PROFILE>"] },
  { id: "profile-valid-json", argv: ["--profile", "<PROFILE>", "--json"] },
  { id: "profile-missing", argv: ["--profile", "<MISSING_PROFILE>"] },
  { id: "profile-missing-json", argv: ["--profile", "<MISSING_PROFILE>", "--json"] },
] as const;

function groupRefusalFixtures(): Fixture[] {
  return GROUP_REFUSAL_SITES.flatMap(verb =>
    ([
      { id: "missing", action: [] },
      { id: "unknown", action: ["not-an-action"] },
    ] as const).flatMap(({ id: actionId, action }) =>
      GROUP_REFUSAL_AXES.map(axis => ({
        id: `refusal.group.${verb}.${actionId}.${axis.id}`,
        argv: [verb, ...action, ...axis.argv],
        ...(verb === "hook" ? { input: "{}" } : {}),
      }))
    )
  );
}

const PROTOTYPE_VERB_AXES = [
  { id: "plain", suffix: [] },
  { id: "json", suffix: ["--json"] },
  { id: "profile-valid", suffix: ["--profile", "<PROFILE>"] },
] as const;

function prototypeVerbFixtures(): Fixture[] {
  return Object.getOwnPropertyNames(Object.prototype).flatMap(verb =>
    PROTOTYPE_VERB_AXES.map(axis => ({
      id: `refusal.prototype-verb.${verb}.${axis.id}`,
      argv: [verb, ...axis.suffix],
    }))
  );
}

/**
 * Every Object.prototype name as the sub-action of every closed selector. The
 * old if-chains refused these names; a lookup that inherits from
 * Object.prototype would select a function such as `toString` as an entry.
 */
function prototypeSubActionFixtures(): Fixture[] {
  return GROUP_REFUSAL_SITES.flatMap(verb =>
    Object.getOwnPropertyNames(Object.prototype).flatMap(action =>
      PROTOTYPE_VERB_AXES.map(axis => ({
        id: `refusal.prototype-sub-action.${verb}.${action}.${axis.id}`,
        argv: [verb, action, ...axis.suffix],
        ...(verb === "hook" ? { input: "{}" } : {}),
      }))
    )
  );
}

/**
 * A file refusal from the server prints JSON only when --json was asked for.
 * After `--`, "--json" is a positional (the file to find), not the flag. The
 * control row asks for the flag and passes the same positional.
 */
const FILE_REFUSAL_JSON_ROUTES: readonly Fixture[] = [
  ...["get", "rm", "restore"].map(action => ({
    id: `refusal.file-refused.terminator-json.${action}`,
    argv: ["file", action, "--profile", "<PROFILE>", "--", "--json"],
  })),
  { id: "refusal.file-refused.flag-and-terminator-json.get", argv: ["file", "get", "--profile", "<PROFILE>", "--json", "--", "--json"] },
];

/** Every entry whose old position reached expandAgentProfile's refuse branch. */
const REFUSE_PROFILE_ROUTES: readonly Fixture[] = [
  { id: "refusal.profile.__listen-supervisor", argv: ["__listen-supervisor"] },
  { id: "refusal.profile.hook", argv: ["hook", "check"], input: "{}" },
  { id: "refusal.profile.login", argv: ["login"] },
  { id: "refusal.profile.logout", argv: ["logout"] },
  { id: "refusal.profile.invite", argv: ["invite"] },
  { id: "refusal.profile.member", argv: ["member", "remove", OTHER_ID] },
  { id: "refusal.profile.workspace", argv: ["workspace", "close", WS] },
  { id: "refusal.profile.target", argv: ["target"] },
  { id: "refusal.profile.status", argv: ["status"] },
  { id: "refusal.profile.workspaces", argv: ["workspaces"] },
  { id: "refusal.profile.use", argv: ["use", WS] },
  { id: "refusal.profile.new", argv: ["new", "Fixture workspace"] },
  { id: "refusal.profile.accept", argv: ["accept", INVITATION_TOKEN] },
  { id: "refusal.profile.principal", argv: ["principal", "create"] },
  { id: "refusal.profile.token", argv: ["token", "mint"] },
  { id: "refusal.profile.grant", argv: ["grant", "resume"] },
  { id: "refusal.profile.link", argv: ["link", "new"] },
  { id: "refusal.profile.command", argv: ["command", "create"] },
  { id: "refusal.profile.dogfood", argv: ["dogfood"] },
  { id: "refusal.profile.seed-fixture", argv: ["seed-fixture"] },
].map(fixture => ({ ...fixture, argv: [...fixture.argv, "--profile", "<PROFILE>"] }));

/**
 * assertShape call sites whose expected positional count can be under-run
 * after the old dispatcher has selected the handler.
 */
const ARITY_REFUSAL_ROUTES: readonly Fixture[] = [
  { id: "refusal.arity.use", argv: ["use"] },
  { id: "refusal.arity.new", argv: ["new"] },
  { id: "refusal.arity.member-remove", argv: ["member", "remove"] },
  { id: "refusal.arity.workspace", argv: ["workspace"] },
  { id: "refusal.arity.receipt", argv: ["receipt"] },
  { id: "refusal.arity.token", argv: ["token"] },
  { id: "refusal.arity.grant", argv: ["grant"] },
  { id: "refusal.arity.command", argv: ["command"] },
  { id: "refusal.arity.hook-install", argv: ["hook", "install"] },
  { id: "refusal.arity.hook-uninstall", argv: ["hook", "uninstall"] },
];

function coreFixtures(): Fixture[] {
  const target = ["--url", "<ORIGIN>", "--anon-key", "fixture-anon-key"];
  const workspace = ["--workspace-id", WS];
  const profile = ["--profile", "<PROFILE>"];
  const credential = ["--agent-token-file", "<CREDENTIAL>"];
  const human = [...target, ...workspace];
  const agent = [...profile];
  return [
    { id: "refusal.unknown-verb", argv: ["invalidverb"] },
    { id: "refusal.unknown-verb.profile-valid", argv: ["nonexistent_verb", ...profile] },
    { id: "refusal.unknown-verb.profile-missing", argv: ["nonexistent_verb", "--profile", "<MISSING_PROFILE>"] },
    ...prototypeVerbFixtures(),
    ...groupRefusalFixtures(),
    ...prototypeSubActionFixtures(),
    ...FILE_REFUSAL_JSON_ROUTES,
    ...REFUSE_PROFILE_ROUTES,
    ...ARITY_REFUSAL_ROUTES,
    { id: "refusal.flag-before.check", argv: ["--json", "check", ...profile, "--force"] },
    { id: "refusal.flag-before.hook-check", argv: ["--json", "hook", "check"], input: "{}" },
    { id: "refusal.flag-before.receive", argv: ["--json", "receive"] },
    { id: "refusal.flag-before.setup", argv: ["--json", "setup"] },
    { id: "refusal.hook-check-extra", argv: ["hook", "check", "extra"], input: "{}" },
    { id: "refusal.flag-before.hook-check-extra", argv: ["--json", "hook", "check", "extra"], input: "{}" },
    { id: "meta.version-long", argv: ["--version"] },
    { id: "meta.version-short", argv: ["-v"] },
    { id: "meta.help-flag", argv: ["not-a-command", "--help"] },
    { id: "meta.help-verb", argv: ["help"] },
    { id: "meta.no-positional-json", argv: ["--json"] },
    { id: "meta.no-positional-profile", argv: profile },
    { id: "meta.bare", argv: [] },

    { id: "setup.import", argv: ["setup", "--connection-file", "<CONNECTION>", "--profile", "<SETUP_PROFILE>", "--json"] },
    { id: "setup.check-version", argv: ["setup", "--check-version"] },
    { id: "setup.guide", argv: ["setup", "guide"] },
    { id: "check.default", argv: ["check", ...profile, "--force", "--json"] },
    { id: "check.profile-before-verb", argv: [...profile, "check", "--force", "--json"] },
    { id: "check.host-session", argv: ["check", ...profile, "--host-session-id", "fixture-host", "--force", "--json"] },
    { id: "check.message-id", argv: ["check", ...profile, "--message-id", SIGNAL_ID, "--json"] },
    { id: "check.hook", argv: ["check", ...profile, "--host-session-id", "fixture-host", "--hook"], input: "{}" },
    { id: "resume.profile", argv: ["resume", ...profile, "--host-session-id", "fixture-host", "--json"] },
    { id: "receive.configure", argv: ["receive", "configure", ...profile, "--mode", "turn", "--provider", "instructions", "--host-session-id", "fixture-host", "--json"] },
    { id: "receive.status", argv: ["receive", "status", ...profile, "--host-session-id", "fixture-host", "--json"] },
    { id: "receive.test", argv: ["receive", "test", ...profile, "--host-session-id", "fixture-host", "--json"] },
    { id: "receive.confirm", argv: ["receive", "confirm", ...profile, "--host-session-id", "fixture-host", "--signal-id", SIGNAL_ID, "--receipt", "fixture-receipt", "--json"] },
    { id: "receive.idle", argv: ["receive", "idle", ...profile, "--host-session-id", "fixture-host", "--json"] },
    { id: "receive.serve", argv: ["receive", "serve", ...profile, "--host-session-id", "fixture-host"] },

    { id: "internal.listen-supervisor", argv: ["__listen-supervisor", ...target, ...workspace, ...credential, "--principal-id", PRINCIPAL, "--cwd", "relative", "--provider", "codex"] },
    { id: "hook.check", argv: ["hook", "check"], input: "{}" },
    { id: "hook.check-extra-positional", argv: ["hook", "check", "extra"], input: "{}" },
    { id: "hook.install", argv: ["hook", "install", "claude", "--principal-id", PRINCIPAL] },
    { id: "hook.uninstall", argv: ["hook", "uninstall", "claude", "--write", "--user"] },
    { id: "listen.start", argv: ["listen", "start", ...agent, "--host-session-id", "fixture-host", "--provider", "codex", "--cwd", "<ROOT>", "--foreground"] },
    { id: "listen.status", argv: ["listen", "status", ...agent, "--host-session-id", "fixture-host", "--state-dir", "<STATE>", "--json"] },
    { id: "listen.stop", argv: ["listen", "stop", ...agent, "--host-session-id", "fixture-host", "--state-dir", "<STATE>", "--json"] },
    { id: "listen.canary", argv: ["listen", "canary", ...agent, "--host-session-id", "fixture-host", "--state-dir", "<STATE>", "--wait", "0", "--json"] },
    { id: "session.start", argv: ["session", "start", ...agent, "--host-session-id", "fixture-host", "--mode", "interactive", "--provider", "codex", "--json"] },
    { id: "session.status", argv: ["session", "status", ...agent, "--host-session-id", "fixture-host", "--session-context", "<SESSION>", "--json"] },
    { id: "session.stop", argv: ["session", "stop", ...agent, "--host-session-id", "fixture-host", "--session-context", "<SESSION>", "--json"] },
    { id: "session.enable", argv: ["session", "enable", ...human, "--principal-id", PRINCIPAL, "--json"] },
    { id: "session.disable", argv: ["session", "disable", ...human, "--principal-id", PRINCIPAL, "--json"] },
    { id: "session.recover", argv: ["session", "recover", ...human, "--principal-id", PRINCIPAL, "--json"] },

    { id: "login", argv: ["login", ...target, "--no-browser"], input: "fixture-code\n" },
    { id: "logout.local", argv: ["logout", ...target, "--local"] },
    { id: "invite.create", argv: ["invite", ...human, "--email", "person@example.test", "--json"] },
    { id: "invite.revoke", argv: ["invite", "revoke", ...human, "--invitation-id", OTHER_ID, "--json"] },
    { id: "member.remove", argv: ["member", "remove", OTHER_ID, ...human, "--confirm", OTHER_ID, "--json"] },
    { id: "workspace.close", argv: ["workspace", "close", WS, ...target, "--confirm", WS, "--json"] },
    { id: "target.default-show", argv: ["target"] },
    { id: "target.show", argv: ["target", "show", "--json"] },
    { id: "target.set", argv: ["target", "set", ...target, "--json"] },
    { id: "target.clear", argv: ["target", "clear", "--json"] },
    { id: "status", argv: ["status", ...human, "--json"] },
    { id: "json.before-verb", argv: ["--json", "status", ...human] },
    { id: "json.after-verb", argv: ["status", ...human, "--json"] },
    { id: "whoami", argv: ["whoami", ...agent, "--json"] },
    { id: "resume.inspect", argv: ["resume", ...credential, ...target, ...workspace, "--json"] },
    { id: "feedback", argv: ["feedback", "fixture feedback", ...agent, "--kind", "bug", "--json"] },

    { id: "channel.create", argv: ["channel", "create", "fixture", ...agent, "--purpose", "fixture", "--json"] },
    { id: "channel.ls", argv: ["channel", "ls", ...agent, "--include-archived", "--json"] },
    { id: "channel.rename", argv: ["channel", "rename", OTHER_ID, "renamed", ...agent, "--json"] },
    { id: "channel.archive", argv: ["channel", "archive", OTHER_ID, ...agent, "--json"] },
    { id: "file.put", argv: ["file", "put", "<TEXT>", ...agent, "--name", "fixture.txt", "--json"] },
    { id: "file.ls", argv: ["file", "ls", ...agent, "--include-tombstoned", "--json"] },
    { id: "file.get", argv: ["file", "get", OTHER_ID, ...agent, "--out", "<DOWNLOAD>", "--json"] },
    { id: "file.rm", argv: ["file", "rm", OTHER_ID, ...agent, "--json"] },
    { id: "file.restore", argv: ["file", "restore", OTHER_ID, ...agent, "--json"] },
    { id: "brain.ls", argv: ["brain", "ls", ...agent, "--json"] },
    { id: "brain.get", argv: ["brain", "get", "fixture-topic", ...agent, "--json"] },
    { id: "brain.put", argv: ["brain", "put", "fixture-topic", "<MARKDOWN>", ...agent, "--json"] },

    { id: "members", argv: ["members", ...agent, "--json"] },
    { id: "working-on", argv: ["working-on", "fixture work", ...agent, "--host-session-id", "fixture-host", "--json"] },
    { id: "note", argv: ["note", "fixture note", ...agent, "--json"] },
    { id: "ask", argv: ["ask", "fixture ask", ...agent, "--to", PRINCIPAL, "--wait", "1", "--json"] },
    { id: "reply", argv: ["reply", SIGNAL_ID, "fixture reply", ...agent, "--json"] },
    { id: "receipt", argv: ["receipt", SIGNAL_ID, ...agent, "--json"] },
    { id: "feed", argv: ["feed", ...agent, "--limit", "1", "--json"] },
    { id: "inbox.default", argv: ["inbox", ...agent, "--limit", "1", "--wait", "1", "--json"] },
    { id: "inbox.notify", argv: ["inbox", ...agent, "--notify", "--json"] },
    { id: "inbox.follow", argv: ["inbox", ...agent, "--follow", "--ndjson"] },

    { id: "workspaces", argv: ["workspaces", ...target, "--json"] },
    { id: "use", argv: ["use", WS, ...target, "--json"] },
    { id: "new.positional", argv: ["new", "Fixture workspace", ...target, "--json"] },
    { id: "new.name-flag", argv: ["new", "--name", "Fixture workspace", ...target, "--json"] },
    { id: "accept.link-stdin", argv: ["accept", "--link-stdin", "--no-browser", "--json"], input: "<INVITE_LINK>" },
    { id: "accept.link-positional", argv: ["accept", "<INVITE_LINK>", "--no-browser", "--json"] },
    { id: "accept.legacy-stdin", argv: ["accept", "--invitation-token-stdin", ...target], input: `${INVITATION_TOKEN}\n` },
    { id: "accept.legacy-positional", argv: ["accept", INVITATION_TOKEN, ...target] },
    { id: "principal.create", argv: ["principal", "create", ...human, "--name", "fixture-agent", "--json"] },
    { id: "principal.revoke", argv: ["principal", "revoke", ...human, "--principal-id", PRINCIPAL, "--json"] },
    { id: "token.mint", argv: ["token", "mint", ...human, "--principal-id", PRINCIPAL, "--run-id", RUN_ID, "--task-id", TASK_ID, "--epoch", "1", "--json"] },
    { id: "token.revoke-human", argv: ["token", "revoke", ...human, "--token-id", TOKEN_ID, "--json"] },
    { id: "token.revoke-agent", argv: ["token", "revoke", ...target, ...workspace, ...credential, "--json"] },
    { id: "grant.resume", argv: ["grant", "resume", ...human, "--renewal-grant-id", OTHER_ID, "--json"] },
    { id: "link.new", argv: ["link", "new", ...human, "--task-id", TASK_ID, "--site", "http://127.0.0.1", "--json"] },
    { id: "link.revoke", argv: ["link", "revoke", ...human, "--capability-id", OTHER_ID, "--json"] },
    { id: "command.create", argv: ["command", "create", ...target, ...workspace, ...credential, "--task-id", TASK_ID, "--slug", "fixture"] },
    { id: "command.acquire", argv: ["command", "acquire", ...target, ...workspace, ...credential, "--task-id", TASK_ID, "--ttl-ms", "1000"] },
    { id: "command.renew", argv: ["command", "renew", ...target, ...workspace, ...credential, "--task-id", TASK_ID, "--epoch", "1", "--ttl-ms", "1000"] },
    { id: "command.handoff", argv: ["command", "handoff", ...target, ...workspace, ...credential, "--task-id", TASK_ID, "--epoch", "1", "--to-owner", "fixture-owner", "--ttl-ms", "1000"] },
    { id: "command.takeover", argv: ["command", "takeover", ...target, ...workspace, ...credential, "--task-id", TASK_ID, "--ttl-ms", "1000"] },
    { id: "command.submit", argv: ["command", "submit", ...target, ...workspace, ...credential, "--task-id", TASK_ID, "--epoch", "1", "--branch", "fixture", "--head-sha", "0123456789abcdef0123456789abcdef01234567", "--evidence", "fixture"] },
    { id: "command.close", argv: ["command", "close", ...target, ...workspace, ...credential, "--task-id", TASK_ID, "--epoch", "1", "--disposition", "archive"] },
    { id: "command.reopen", argv: ["command", "reopen", ...target, ...workspace, ...credential, "--task-id", TASK_ID, "--epoch", "1"] },
    { id: "dogfood", argv: ["dogfood", ...target, ...workspace, ...credential, "--slug", "fixture", "--branch", "fixture", "--head-sha", "0123456789abcdef0123456789abcdef01234567", "--evidence", "fixture"] },
    { id: "seed-fixture", argv: ["seed-fixture", "--uid", OTHER_ID], env: { DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/fixture", SEED_TOKEN_OUT: "<SEED>" } },
  ];
}

const GROUP_NAMES = new Set<string>(GROUP_REFUSAL_SITES);

function canonicalFixtureId(key: string): string {
  if (key.endsWith(".refusal")) {
    const groupName = key.slice(0, -".refusal".length);
    assert.ok(GROUP_NAMES.has(groupName), `no refusal fixture group for ${key}`);
    return `refusal.group.${groupName}.missing.plain`;
  }
  const overrides: Record<string, string> = {
    setup: "setup.import",
    check: "check.default",
    "__listen-supervisor": "internal.listen-supervisor",
    logout: "logout.local",
    resume: "resume.profile",
    inbox: "inbox.default",
    new: "new.positional",
    accept: "accept.link-positional",
    "token.revoke": "token.revoke-human",
    command: "command.create",
  };
  return overrides[key] ?? key;
}

function withoutOptions(argv: readonly string[], names: Readonly<Record<string, "boolean" | "value">>): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const kind = names[token];
    if (kind === undefined) {
      result.push(token);
      continue;
    }
    if (kind === "value") index += 1;
  }
  return result;
}

function hostSessionFixtures(
  coverage: readonly CommandEntryCoverage[],
  sources: readonly Fixture[],
): Fixture[] {
  const byId = new Map(sources.map(fixture => [fixture.id, fixture]));
  return coverage.map(entry => {
    const sourceId = canonicalFixtureId(entry.key);
    const source = byId.get(sourceId);
    assert.ok(source, `no canonical fixture ${sourceId} for ${entry.key}`);
    const argv = withoutOptions(source.argv, {
      "--profile": "value",
      "--host-session-id": "value",
    });
    return {
      id: `policy.host-session.${entry.key}.${entry.hostSessionId}`,
      argv: [...argv, "--profile", "<PROFILE>", "--host-session-id", "fixture-host"],
      ...(source.input === undefined ? {} : { input: source.input }),
      ...(source.env === undefined ? {} : { env: source.env }),
    };
  });
}

const SELECTED_ERROR_AXES = [
  { id: "json-before", prefix: ["--json"], suffix: [] },
  { id: "profile-valid-before", prefix: ["--profile", "<PROFILE>"], suffix: ["--json"] },
  { id: "profile-missing-before", prefix: ["--profile", "<MISSING_PROFILE>"], suffix: ["--json"] },
  { id: "json-profile-valid-before", prefix: ["--json", "--profile", "<PROFILE>"], suffix: [] },
  { id: "json-profile-missing-before", prefix: ["--json", "--profile", "<MISSING_PROFILE>"], suffix: [] },
  { id: "profile-json-valid-before", prefix: ["--profile", "<PROFILE>", "--json"], suffix: [] },
  { id: "profile-json-missing-before", prefix: ["--profile", "<MISSING_PROFILE>", "--json"], suffix: [] },
  { id: "host-before", prefix: ["--host-session-id", "fixture-host"], suffix: ["--profile", "<PROFILE>", "--json"] },
] as const;

function selectedErrorSource(
  entry: CommandEntryCoverage,
  variant: string,
  sources: readonly Fixture[],
): Fixture {
  const byId = new Map(sources.map(fixture => [fixture.id, fixture]));
  if (entry.errorMode === "onboarding") {
    const argvByKey: Record<string, string[]> = {
      "setup.import": ["setup"],
      "setup.version": ["setup", "--check-version"],
      "setup.guide": ["setup", "guide"],
      "check.messages": ["check", "--force"],
      "check.message": ["check", "--message-id", SIGNAL_ID],
      "check.hook": ["check", "--hook"],
      "receive.configure.default": ["receive", "configure"],
      "receive.status.default": ["receive", "status"],
      "receive.test.default": ["receive", "test"],
      "receive.confirm.default": ["receive", "confirm"],
      "receive.idle.default": ["receive", "idle"],
      "receive.serve.default": ["receive", "serve", "extra"],
      "receive.refusal.default": ["receive"],
    };
    const route = `${entry.key}.${variant}`;
    const argv = argvByKey[route];
    assert.ok(argv, `no onboarding error fixture for ${route}`);
    return { id: route, argv, ...(route === "check.hook" ? { input: "{}" } : {}) };
  }

  const sourceId = entry.key === "inbox"
    ? variant === "read" ? "inbox.default" : `inbox.${variant}`
    : canonicalFixtureId(entry.key);
  const source = byId.get(sourceId);
  assert.ok(source, `no workspace error fixture ${sourceId} for ${entry.key}`);
  const argv = withoutOptions(source.argv, {
    "--profile": "value",
    "--host-session-id": "value",
    "--json": "boolean",
    "--url": "value",
    "--anon-key": "value",
    "--workspace-id": "value",
    "--agent-token-file": "value",
    "--agent-token-stdin": "boolean",
  });
  if (entry.key === "use") argv[1] = "missing-workspace";
  return {
    id: entry.key,
    argv: [...argv, "--url", "<ORIGIN>", "--anon-key", "fixture-anon-key", "--force-file-store"],
    ...(source.input === undefined ? {} : { input: source.input }),
    humanSession: true,
  };
}

function selectedErrorFixtures(
  coverage: readonly CommandEntryCoverage[],
  sources: readonly Fixture[],
): Fixture[] {
  return coverage
    .filter(entry => entry.errorMode === "onboarding" || entry.workspaceErrorJson)
    .flatMap(entry => {
      return entry.variants.flatMap((variant, variantIndex) => {
        const source = selectedErrorSource(entry, variant, sources);
        const variantId = variantIndex === 0 ? "" : `.${variant}`;
        return SELECTED_ERROR_AXES.map(axis => ({
          ...source,
          id: `selected-error.${entry.key}${variantId}.${axis.id}`,
          argv: [...axis.prefix, ...source.argv, ...axis.suffix],
        }));
      });
    });
}

async function fixtures(): Promise<Fixture[]> {
  const core = coreFixtures();
  const coverage = await commandEntryCoverage();
  const generated = [
    ...hostSessionFixtures(coverage, core),
    ...selectedErrorFixtures(coverage, core),
  ];
  const ids = [...core, ...generated].map(fixture => fixture.id);
  assert.equal(new Set(ids).size, ids.length, "baseline fixture ids must be unique");
  return [...core, ...generated];
}

async function prepareRow(root: string, origin: string, fixture: Fixture) {
  const rowRoot = join(root, fixture.id.replace(/[^a-z0-9.-]/gi, "_"));
  const privateDir = join(rowRoot, "private");
  const stateDir = join(rowRoot, "state");
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  await chmod(privateDir, 0o700);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const credentialPath = join(privateDir, "credential.json");
  const profilePath = join(privateDir, "profile.json");
  const credential = {
    message: "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.",
    status: "accepted",
    principal_id: PRINCIPAL,
    token_id: TOKEN_ID,
    run_id: RUN_ID,
    agent_token: AGENT_TOKEN,
    expires_at: "2099-01-01T00:00:00.000Z",
  };
  await writeFile(credentialPath, JSON.stringify(credential), { mode: 0o600 });
  await writeFile(profilePath, JSON.stringify({
    version: 1,
    url: origin,
    anon_key: "fixture-anon-key",
    workspace_id: WS,
    principal_id: PRINCIPAL,
    credential_file: credentialPath,
  }), { mode: 0o600 });
  if (fixture.humanSession) {
    const humanStore = await credentialStore({
      target: cloudTarget(origin, "fixture-anon-key"),
      stateDirectory: join(rowRoot, ".cswarm", "credentials.d"),
      forceFile: true,
      platform: "linux",
      warn: () => undefined,
    });
    await humanStore.write({
      version: 1,
      refreshToken: "fixture-refresh-token",
      generation: 0,
      deviceId: HUMAN_DEVICE,
      userId: HUMAN_USER,
    });
    await humanStore.writeProfile({
      version: 1,
      userId: HUMAN_USER,
      workspaceId: null,
      pendingCommands: {},
    });
  }
  const connectionPath = join(privateDir, "connection.json");
  await writeFile(connectionPath, JSON.stringify({
    version: 1,
    url: origin,
    anon_key: "fixture-anon-key",
    workspace_id: WS,
    principal_id: PRINCIPAL,
    credential,
  }), { mode: 0o600 });
  const textPath = join(rowRoot, "fixture.txt");
  const markdownPath = join(rowRoot, "fixture.md");
  await writeFile(textPath, "fixture text\n");
  await writeFile(markdownPath, "# Fixture\n");
  const invitation: InviteLinkPayload = {
    v: 1,
    url: origin,
    anon_key: "fixture-anon-key",
    workspace_id: WS,
    invitation_token: INVITATION_TOKEN,
    workspace_name: "Fixture workspace",
    inviter_display_name: "Fixture person",
    inviter_user_id: OTHER_ID,
  };
  const replacements: Record<string, string> = {
    "<ORIGIN>": origin,
    "<ROOT>": rowRoot,
    "<PROFILE>": profilePath,
    "<MISSING_PROFILE>": join(privateDir, "missing-profile.json"),
    "<SETUP_PROFILE>": join(privateDir, "setup", "profile.json"),
    "<CONNECTION>": connectionPath,
    "<CREDENTIAL>": credentialPath,
    "<STATE>": stateDir,
    "<SESSION>": join(rowRoot, "missing-session.json"),
    "<TEXT>": textPath,
    "<MARKDOWN>": markdownPath,
    "<DOWNLOAD>": join(rowRoot, "download.txt"),
    "<SEED>": join(rowRoot, "seed.json"),
    "<INVITE_LINK>": encodeInviteLink(invitation),
  };
  const replace = (value: string) => Object.hasOwn(replacements, value) ? replacements[value]! : value;
  return {
    rowRoot,
    stateDir,
    argv: fixture.argv.map(replace),
    input: replace(fixture.input ?? ""),
    env: Object.fromEntries(Object.entries(fixture.env ?? {}).map(([key, value]) => [key, replace(value)])),
  };
}

function normalize(value: string, root: string, origin: string): string {
  return value
    .replaceAll(root, "<ROOT>")
    .replaceAll(origin, "<ORIGIN>")
    .replaceAll(repoRoot, "<REPO>")
    .replace(/credentials\.d\/[a-f0-9]{24}/g, "credentials.d/<PROFILE_ID>")
    .replace(/<ORIGIN>\/auth\/v1\/authorize\?[^\n]+/g, "<AUTHORIZATION_URL>")
    .replace("If the browser cannot reach the loopback callback, paste the complete callback URL here:\n", "")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TIMESTAMP>")
    .replace(/coverage-[0-9-]+\.json/g, "coverage-<ID>.json");
}

async function runFixture(root: string, origin: string, fixture: Fixture): Promise<BaselineRow> {
  const prepared = await prepareRow(root, origin, fixture);
  return await new Promise<BaselineRow>((resolveRun, rejectRun) => {
    const handlers: string[] = [];
    const child = spawn(process.execPath, [
      "--import", "tsx",
      "--import", preloadPath,
      cliPath,
      ...prepared.argv,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: prepared.rowRoot,
        XDG_CONFIG_HOME: join(prepared.rowRoot, "config"),
        SWARM_AGENT_STATE_DIR: prepared.stateDir,
        SWARM_LISTENER_STATE_DIR: prepared.stateDir,
        SWARM_CLOUD_URL: origin,
        SWARM_CLOUD_ANON_KEY: "fixture-anon-key",
        SWARM_ALLOW_INSECURE_STORE: "1",
        ...prepared.env,
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    let stderr = "";
    let loginCallbackSent = false;
    child.stdout!.on("data", chunk => stdout += String(chunk));
    child.stderr!.on("data", chunk => {
      stderr += String(chunk);
      if (!(fixture.id === "login" || fixture.id.startsWith("accept.link-")) || loginCallbackSent) return;
      for (const line of stderr.split("\n")) {
        try {
          const authorization = new URL(line.trim());
          const redirectValue = authorization.searchParams.get("redirect_to");
          if (redirectValue === null) continue;
          const callback = new URL(redirectValue);
          callback.searchParams.set("code", "fixture-code");
          loginCallbackSent = true;
          void fetch(callback).catch(rejectRun);
          break;
        } catch {
          // The surrounding stderr lines are narration, not URLs.
        }
      }
    });
    child.on("message", message => {
      if (message && typeof message === "object" &&
          (message as { type?: unknown }).type === "commonswarm-dispatch" &&
          typeof (message as { handler?: unknown }).handler === "string") {
        handlers.push((message as { handler: string }).handler);
      }
    });
    child.once("error", rejectRun);
    child.once("close", code => resolveRun({
      id: fixture.id,
      argv: fixture.argv,
      exitCode: code ?? 1,
      stdout: normalize(stdout, root, origin),
      stderr: normalize(stderr, root, origin),
      handlers,
    }));
    child.stdin!.end(prepared.input);
  });
}

test("the command dispatcher matches the recorded behavior baseline", { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-dispatch-baseline-"));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/auth/v1/token") {
      const now = new Date().toISOString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: "fixture-access-token",
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: "fixture-rotated-refresh-token",
        user: {
          id: HUMAN_USER,
          aud: "authenticated",
          role: "authenticated",
          email: "person@example.test",
          email_confirmed_at: now,
          confirmed_at: now,
          last_sign_in_at: now,
          app_metadata: { provider: "email", providers: ["email"] },
          user_metadata: {},
          identities: [],
          created_at: now,
          updated_at: now,
          is_anonymous: false,
        },
      }));
      return;
    }
    if (url.pathname === "/rest/v1/memberships") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([
        { workspace_id: WS, user_id: HUMAN_USER, role: "owner" },
        { workspace_id: OTHER_ID, user_id: HUMAN_USER, role: "member" },
      ]));
      return;
    }
    if (url.pathname === "/rest/v1/workspaces") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([
        { workspace_id: WS, name: "Fixture one", archived_at: null },
        { workspace_id: OTHER_ID, name: "Fixture two", archived_at: null },
      ]));
      return;
    }
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "fixture_boundary", message: "fixture stopped at local network boundary" }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const rows: BaselineRow[] = [];
    for (const fixture of await fixtures()) rows.push(await runFixture(root, origin, fixture));
    const counts = {
      total: rows.length,
      exitCodeZero: rows.filter(row => row.exitCode === 0).length,
      exitCodeNonzero: rows.filter(row => row.exitCode !== 0).length,
    };
    if (process.env.UPDATE_DISPATCH_BASELINE === "1") {
      await writeFile(baselinePath, `${JSON.stringify(rows, null, 2)}\n`);
      await writeFile(baselineCountsPath, `${JSON.stringify(counts, null, 2)}\n`);
    }
    const expected = JSON.parse(await readFile(baselinePath, "utf8")) as BaselineRow[];
    const expectedCounts = JSON.parse(await readFile(baselineCountsPath, "utf8")) as typeof counts;
    assert.deepEqual(rows, expected);
    assert.deepEqual(counts, expectedCounts);
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

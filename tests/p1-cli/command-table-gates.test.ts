import assert from "node:assert/strict";
import { MCP_TOOLS } from "../../src/mcp/tools.js";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as cliAccepted from "../../src/cli.js";
import * as onboardingAccepted from "../../src/onboarding-cli.js";
import {
  AGENT_COMMANDS,
  AGENT_PROFILE_COMMANDS,
  agentToolsForTransport,
  commandHelpLines,
  helpDescription,
  visibleUsageHint,
  HANDLER_HELP_FLAGS,
  VARIANT_HELP_FLAGS,
  SESSION_HUMAN_ACCEPTED_FLAGS,
  SESSION_START_ACCEPTED_FLAGS,
  SESSION_STATUS_ACCEPTED_FLAGS,
  SESSION_PROFILE_STATUS_ACCEPTED_FLAGS,
  LISTEN_START_ACCEPTED_FLAGS,
  LISTEN_STATUS_ACCEPTED_FLAGS,
  LISTEN_CANARY_ACCEPTED_FLAGS,
  FEEDBACK_KINDS,
  LISTENER_PERMISSION_MODES,
  listenerPermissionMode,
  usage,
  type AgentCommandEntry,
  type AgentCommandGroup,
} from "../../src/cli.js";
import { AGENT_QUICK_GUIDE } from "../../src/cloud/agent-onboarding-contract.js";
import { CHECK_HOOK_REFUSED_FLAGS, CHECK_MESSAGE_REFUSED_FLAGS, onboardingUsage } from "../../src/onboarding-cli.js";
import { CHANNEL_PURPOSE_MAX } from "../../src/cloud/channels.js";
import { listenerRouteUsage } from "../../src/listener/index.js";
import { parseSessionMode, parseSessionProvider } from "../../src/cloud/session-cli.js";
import { SESSION_PROVIDERS } from "../../src/cloud/session-contract.js";
import { LISTENER_PROVIDERS, isListenerProvider, type ListenerProviderId } from "../../src/listener/control.js";
import { parseReceiveMode, parseReceiveProvider } from "../../src/cloud/agent-receive.js";
import { SINCE_OFFSET_GUIDANCE } from "../../src/cloud/signals.js";
import { NOTIFY_FLAG } from "../../src/cloud/arrival-watch.js";

type EntryRow = { key: string; entry: AgentCommandEntry };
const sessionProvidersMustBeListenerProviders: readonly ListenerProviderId[] = SESSION_PROVIDERS;
void sessionProvidersMustBeListenerProviders;

function isGroup(value: AgentCommandEntry | AgentCommandGroup): value is AgentCommandGroup {
  return "subcommands" in value;
}

function entries(includeRefusals = false): EntryRow[] {
  const rows: EntryRow[] = [];
  for (const [verb, root] of Object.entries(AGENT_COMMANDS)) {
    if (!isGroup(root)) {
      rows.push({ key: verb, entry: root });
      continue;
    }
    for (const [action, entry] of Object.entries(root.subcommands)) {
      rows.push({ key: `${verb}.${action}`, entry });
    }
    if (includeRefusals) rows.push({ key: `${verb}.refusal`, entry: root.refusal });
  }
  return rows;
}

const SELECTED_VARIANT_HELP_SHAPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  setup: {
    import: "--connection-file",
    version: "--check-version",
    guide: "cswarm setup guide",
  },
  check: {
    messages: "cswarm check --profile <absolute-path> [--host-session-id <id>] [--force] [--full] [--json]",
    message: "--message-id",
    hook: "--hook",
  },
  resume: {
    inspect: "--agent-token-file",
    profile: "--profile",
  },
  inbox: {
    read: "cswarm inbox [",
    notify: "--notify",
    follow: "--follow",
  },
  accept: {
    linkStdin: "--link-stdin",
    legacyStdin: "--invitation-token-stdin",
    positional: "cswarm accept <",
  },
};

test("generated help covers every visible command, variant, and accepted flag", { timeout: 10_000 }, () => {
  const all = commandHelpLines();
  assert.ok(usage().includes(all));
  const expected: string[] = [];
  for (const { key, entry } of entries()) {
    if (!entry.visible) continue;
    const [verb, action] = key.split(".");
    const section = commandHelpLines(verb, action);
    const namedFlags = new Set([...section.matchAll(/--([a-z][a-z-]*)\b/g)].map(match => match[1]!));
    assert.ok(section.startsWith("  cswarm "), `${key} has no synopsis`);
    assert.ok(section.includes(entry.description), `${key} has no description`);
    const accepted = new Set(HANDLER_HELP_FLAGS[key]);
    if (entry.profile === "expand") { accepted.add("profile"); accepted.add("host-session-id"); }
    assert.deepEqual([...namedFlags].sort(), [...accepted].sort(), `${key} help differs from handler acceptance`);
    for (const variant of Object.values(entry.variants)) {
      assert.ok(variant.help.length > 0, `${key}.${variant.id} has no variant synopsis`);
      for (const hint of variant.help) {
        assert.ok(section.includes(hint.split("  #")[0]!), `${key}.${variant.id} hint is absent`);
        for (const match of hint.matchAll(/--([a-z][a-z-]*)/g)) {
          assert.ok(accepted.has(match[1]!), `${key}.${variant.id} help names unaccepted --${match[1]}`);
        }
      }
    }
    expected.push(section);
  }
  assert.equal(all, expected.join("\n"), "help has a command outside the table or omits one");
});

test("multi-variant help prints each variant's own accepted flags", { timeout: 10_000 }, () => {
  const variants = entries().filter(row => Object.keys(row.entry.variants).length > 1);
  const expectedKeys = variants.flatMap(row => Object.keys(row.entry.variants).map(id => `${row.key}.${id}`));
  assert.deepEqual(Object.keys(VARIANT_HELP_FLAGS).sort(), expectedKeys.sort());
  for (const { key, entry } of variants) {
    const [verb, action] = key.split(".");
    const section = commandHelpLines(verb, action);
    const declared = Object.entries(entry.variants);
    for (let index = 0; index < declared.length; index++) {
      const [variantName, variant] = declared[index]!;
      const start = section.indexOf(`  ${variant.help[0]}`);
      assert.ok(start >= 0, `${key}.${variant.id} missing`);
      const next = declared[index + 1]?.[1];
      const end = next ? section.indexOf(`  ${next.help[0]}`, start + 1) : section.length;
      const rendered = new Set([...section.slice(start, end).matchAll(/--([a-z][a-z-]*)\b/g)].map(match => match[1]!));
      const accepted = new Set(VARIANT_HELP_FLAGS[`${key}.${variantName}`]);
      if (entry.profile === "expand") { accepted.add("profile"); accepted.add("host-session-id"); }
      assert.deepEqual([...rendered].sort(), [...accepted].sort(), `${key}.${variant.id}`);
    }
  }
});

test("variant help renders the flags bound to its handler shape", { timeout: 10_000 }, async () => {
  const cliSource = await readFile(resolve("src/cli.ts"), "utf8");
  const onboardingSource = await readFile(resolve("src/onboarding-cli.ts"), "utf8");
  const cliAst = ts.createSourceFile("src/cli.ts", cliSource, ts.ScriptTarget.Latest, true);
  const onboardingAst = ts.createSourceFile("src/onboarding-cli.ts", onboardingSource, ts.ScriptTarget.Latest, true);
  const cases: { key: string; handler: string; shape: string; route?: string; excluded?: readonly string[]; extra?: readonly string[]; onboarding?: boolean }[] = [
    { key: "setup.import", handler: "runSetupImport", shape: "RUN_SETUP_IMPORT_1_ACCEPTED_FLAGS", onboarding: true },
    { key: "setup.version", handler: "runSetupVersion", shape: "RUN_SETUP_VERSION_1_ACCEPTED_FLAGS", onboarding: true },
    { key: "setup.guide", handler: "runSetupGuide", shape: "RUN_SETUP_GUIDE_1_ACCEPTED_FLAGS", onboarding: true },
    { key: "check.messages", handler: "runCheckMessages", shape: "CHECK_FLAGS", excluded: ["message-id", "hook"], onboarding: true },
    { key: "check.message", handler: "runCheckMessage", shape: "CHECK_FLAGS", excluded: ["force", ...CHECK_MESSAGE_REFUSED_FLAGS, "hook"], onboarding: true },
    { key: "check.hook", handler: "runCheckHook", shape: "CHECK_FLAGS", excluded: CHECK_HOOK_REFUSED_FLAGS, onboarding: true },
    { key: "resume.inspect", handler: "runResume", shape: "RUN_RESUME_1_ACCEPTED_FLAGS" },
    { key: "resume.profile", handler: "runResumeSnapshot", shape: "RUN_RESUME_SNAPSHOT_1_ACCEPTED_FLAGS", onboarding: true },
    { key: "inbox.read", handler: "runSignalRead", route: "runInboxReadMode", shape: "SIGNAL_READ_INBOX_ACCEPTED_FLAGS", excluded: ["follow", "ndjson", "notify"] },
    { key: "inbox.notify", handler: "runSignalRead", route: "runInboxNotifyMode", shape: "NOTIFY_ACCEPTED_FLAGS" },
    { key: "inbox.follow", handler: "runSignalRead", route: "runInboxFollowMode", shape: "SIGNAL_READ_INBOX_ACCEPTED_FLAGS", excluded: [...cliAccepted.INBOX_FOLLOW_REFUSED_FLAGS, NOTIFY_FLAG] },
    { key: "accept.linkStdin", handler: "runAccept", route: "runAcceptLinkStdinMode", shape: "RUN_ACCEPT_1_ACCEPTED_FLAGS", excluded: cliAccepted.ACCEPT_LINK_REFUSED_FLAGS },
    { key: "accept.legacyStdin", handler: "invitationCredential", route: "runAcceptLegacyStdinMode", shape: "INVITATION_CREDENTIAL_1_ACCEPTED_FLAGS" },
    { key: "accept.positional", handler: "runAccept", route: "runAcceptPositionalMode", shape: "RUN_ACCEPT_2_ACCEPTED_FLAGS" },
  ];
  assert.deepEqual(cases.map(row => row.key).sort(), Object.keys(VARIANT_HELP_FLAGS).sort());
  for (const row of cases) {
    const [verb, variantName] = row.key.split(".");
    const variantDeclaration = cliSource.match(new RegExp(`\\b${variantName}: commandVariant\\([^\\n]+`));
    assert.ok(variantDeclaration, `${row.key} has no AST visible variant declaration`);
    assert.match(variantDeclaration[0], new RegExp(`\\b${row.route ?? row.handler}\\b`), `${row.key} is not routed to ${row.handler}`);
    if (row.route) assert.match(cliSource, new RegExp(`const ${row.route}:[^\\n]+=> await ${row.handler === "invitationCredential" ? "runAccept" : row.handler}\\(`));
    if (row.handler === "invitationCredential") assert.match(cliSource, /async function runLegacyAccept[\s\S]*?await invitationCredential\(args\)/);
    const ast = row.onboarding ? onboardingAst : cliAst;
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === row.handler);
    assert.ok(declaration && ts.isFunctionDeclaration(declaration), row.handler);
    assert.match(declaration.getText(ast), new RegExp(`args\\.assertShape\\([\\s\\S]*?\\b${row.shape}\\b`), row.key);
    const exported = ast.statements.filter(ts.isVariableStatement)
      .find(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
        && node.declarationList.declarations.some(item => item.name.getText(ast) === row.shape));
    assert.ok(exported, `${row.key} shape ${row.shape} is not exported`);
    const module = row.onboarding ? onboardingAccepted : cliAccepted;
    const shape = (module as Record<string, unknown>)[row.shape];
    assert.ok(Array.isArray(shape), row.shape);
    const entry = entries().find(item => item.key === verb)?.entry;
    assert.ok(entry);
    const variants = Object.entries(entry.variants);
    const index = variants.findIndex(([name]) => name === variantName);
    assert.ok(index >= 0, row.key);
    const section = commandHelpLines(verb);
    const start = section.indexOf(`  ${variants[index]![1].help[0]}`);
    const end = variants[index + 1] ? section.indexOf(`  ${variants[index + 1]![1].help[0]}`, start + 1) : section.length;
    assert.ok(start >= 0 && end > start, row.key);
    const rendered = [...new Set([...section.slice(start, end).matchAll(/--([a-z][a-z-]*)\b/g)].map(match => match[1]!))].sort();
    const expected = [...new Set([...(shape as string[]).filter(flag => !row.excluded?.includes(flag)), ...(row.extra ?? []),
      ...(entry.profile === "expand" ? ["profile", "host-session-id"] : [])])].sort();
    assert.deepEqual(rendered, expected, row.key);
  }
  assert.match(onboardingSource, /CHECK_HOOK_REFUSED_FLAGS\.some\(flag => args\.has\(flag\)\)/);
  assert.match(cliSource, /get "check\.hook"\(\) \{ return CHECK_FLAGS\.filter\(flag => !\(CHECK_HOOK_REFUSED_FLAGS/);
});

test("single command help omits flags the handler always refuses", { timeout: 10_000 }, async () => {
  const source = await readFile(resolve("src/cli.ts"), "utf8");
  const ast = ts.createSourceFile("src/cli.ts", source, ts.ScriptTarget.Latest, true);
  const logout = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "runLogout");
  assert.ok(logout && ts.isFunctionDeclaration(logout));
  assert.match(logout.getText(ast), /args\.assertShape\(RUN_LOGOUT_1_ACCEPTED_FLAGS/);
  assert.match(logout.getText(ast), /LOGOUT_REFUSED_FLAGS\.some\(flag => args\.optional\(flag\) !== undefined\)[\s\S]*?throw new Error/);
  const renderedLogout = [...new Set([...commandHelpLines("logout").matchAll(/--([a-z][a-z-]*)\b/g)].map(match => match[1]!))].sort();
  assert.deepEqual(renderedLogout, [...cliAccepted.RUN_LOGOUT_1_ACCEPTED_FLAGS.filter(flag => !(cliAccepted.LOGOUT_REFUSED_FLAGS as readonly string[]).includes(flag))].sort());
  const renderedListen = [...new Set([...commandHelpLines("listen", "start").matchAll(/--([a-z][a-z-]*)\b/g)].map(match => match[1]!))].sort();
  assert.deepEqual(renderedListen, [...new Set([...LISTEN_START_ACCEPTED_FLAGS.filter(flag => !(cliAccepted.LISTEN_START_REFUSED_FLAGS as readonly string[]).includes(flag)), "profile"])].sort());
  assert.match(source, /LISTEN_START_REFUSED_FLAGS as readonly string\[\]\)\.find\(flag => supplied\[flag\] !== undefined \|\| args\?\.has\(flag\)\)/);
});

test("removing a handler refusal makes its flag reappear in help", { timeout: 10_000 }, async () => {
  const cliSource = await readFile(resolve("src/cli.ts"), "utf8");
  const onboardingSource = await readFile(resolve("src/onboarding-cli.ts"), "utf8");
  for (const name of ["LISTEN_START_REFUSED_FLAGS", "SESSION_START_REFUSED_FLAGS", "LOGOUT_REFUSED_FLAGS", "INBOX_FOLLOW_REFUSED_FLAGS", "ACCEPT_LINK_REFUSED_FLAGS"]) {
    assert.match(cliSource, new RegExp(`${name}[\\s\\S]*?\\.find\\(|${name}\\.some\\(|${name}\\.includes\\(`), `${name} is not used by its handler`);
  }
  for (const name of ["CHECK_MESSAGE_REFUSED_FLAGS", "CHECK_HOOK_REFUSED_FLAGS"]) {
    assert.match(onboardingSource, new RegExp(`${name}\\.some\\(flag => args\\.has\\(flag\\)\\)`), `${name} is not used by its handler`);
  }
  const cases: { key: string; flags: readonly string[] }[] = [
    { key: "listen.start", flags: cliAccepted.LISTEN_START_REFUSED_FLAGS },
    { key: "session.start", flags: cliAccepted.SESSION_START_REFUSED_FLAGS },
    { key: "logout", flags: cliAccepted.LOGOUT_REFUSED_FLAGS },
    { key: "check.message", flags: CHECK_MESSAGE_REFUSED_FLAGS },
    { key: "check.hook", flags: CHECK_HOOK_REFUSED_FLAGS },
    { key: "inbox.follow", flags: cliAccepted.INBOX_FOLLOW_REFUSED_FLAGS },
    { key: "accept.linkStdin", flags: cliAccepted.ACCEPT_LINK_REFUSED_FLAGS },
  ];
  const variantKeys = new Set(Object.keys(VARIANT_HELP_FLAGS));
  const rendered = (key: string): string => {
    const [verb, action] = key.split(".");
    const entry = entries().find(row => row.key === verb)?.entry;
    if (!variantKeys.has(key) || !entry) return commandHelpLines(verb, action);
    const variants = Object.entries(entry.variants);
    const index = variants.findIndex(([name]) => name === action);
    assert.ok(index >= 0, key);
    const section = commandHelpLines(verb);
    const start = section.indexOf(`  ${variants[index]![1].help[0]}`);
    const end = variants[index + 1] ? section.indexOf(`  ${variants[index + 1]![1].help[0]}`, start + 1) : section.length;
    return section.slice(start, end);
  };
  for (const { key, flags } of cases) {
    const mutable = flags as string[];
    const flag = mutable[0]!;
    assert.ok(!rendered(key).includes(`--${flag}`), `${key} initially shows refused --${flag}`);
    mutable.splice(0, 1);
    try { assert.ok(rendered(key).includes(`--${flag}`), `${key} did not reveal removed --${flag}`); }
    finally { mutable.splice(0, 0, flag); }
  }
});

test("added refusal flags reach the listen and inbox handlers and disappear from help", { timeout: 10_000 }, () => {
  const listen = cliAccepted.LISTEN_START_REFUSED_FLAGS as unknown as string[];
  assert.deepEqual(cliAccepted.listenerRouteConfiguration("main", undefined).routeMode, "main");
  listen.push("route");
  try {
    assert.throws(() => cliAccepted.listenerRouteConfiguration("main", undefined), /--route/);
    assert.ok(!HANDLER_HELP_FLAGS["listen.start"]!.includes("route"));
    assert.doesNotMatch(commandHelpLines("listen", "start"), /--route\b/);
  } finally { listen.pop(); }
  listen.push("poll-interval");
  try {
    const args = new cliAccepted.Arguments(["listen", "start", "--poll-interval", "15s"]);
    assert.throws(() => cliAccepted.listenerRouteConfiguration("main", undefined, args), /--poll-interval/);
    assert.ok(!HANDLER_HELP_FLAGS["listen.start"]!.includes("poll-interval"));
    assert.doesNotMatch(commandHelpLines("listen", "start"), /--poll-interval\b/);
  } finally { listen.pop(); }

  const follow = cliAccepted.INBOX_FOLLOW_REFUSED_FLAGS as unknown as string[];
  for (const [options, expected] of [
    [["--channel", "fixture"], "inbox --follow cannot be combined with --channel"],
    [["--wait", "1"], "inbox --follow cannot be combined with --wait"],
    [["--json"], "inbox --follow --ndjson cannot be combined with --json"],
    [["--wait", "1", "--channel", "fixture"], "inbox --follow cannot be combined with --channel"],
  ] as const) {
    assert.equal(cliAccepted.inboxFollowRefusal(new cliAccepted.Arguments(["inbox", "--follow", "--ndjson", ...options])), expected);
  }
  assert.throws(() => cliAccepted.inboxFollowRefusal(new cliAccepted.Arguments(["inbox", "--follow", "--ndjson", "--wait", "1", "--wait", "2"])),
    { message: "--wait may only be provided once" });
  const args = new cliAccepted.Arguments(["inbox", "--follow", "--ndjson", "--about", "fixture"]);
  assert.equal(cliAccepted.inboxFollowRefusal(args), null);
  follow.push("about");
  try {
    assert.match(cliAccepted.inboxFollowRefusal(args) ?? "", /--about/);
    assert.ok(!VARIANT_HELP_FLAGS["inbox.follow"]!.includes("about"));
    const section = commandHelpLines("inbox").split("cswarm inbox --follow")[1] ?? "";
    assert.doesNotMatch(section, /--about\b/);
  } finally { follow.pop(); }
});

test("all help descriptions agree with attachment flags and synopses", { timeout: 10_000 }, () => {
  for (const { key, entry } of entries()) {
    if (!entry.visible) continue;
    const rendered = commandHelpLines(...(key.includes(".") ? key.split(".") as [string, string] : [key]));
    const hasAttach = [...entry.flags, ...(entry.cliOnlyFlags ?? [])].includes("attach");
    for (const variant of Object.values(entry.variants)) {
      const synopsisHasAttach = variant.help.some(hint => hint.includes("--attach"));
      assert.equal(synopsisHasAttach, hasAttach, key);
    }
    assert.equal(helpDescription(entry).includes("Use --attach to add files."), hasAttach, key);
    if (hasAttach) {
      assert.match(rendered, /--attach/);
      assert.doesNotMatch(rendered, /without attachments/i);
    }
  }
});

test("usage synopsis removes any refused bracket group regardless of group or flag count", { timeout: 10_000 }, () => {
  assert.equal(visibleUsageHint("cswarm example [--first <x> | --second <y>] [--third]", ["first", "third"]),
    "cswarm example [--third]");
  assert.equal(visibleUsageHint("cswarm example [--outer [--inner]] [--third]", ["third"]),
    "cswarm example [--third]");
  assert.equal(visibleUsageHint("cswarm reply [--thread [--broadcast-to-channel]] [--json]", ["broadcast-to-channel", "json"]),
    "cswarm reply [--json]");
  assert.equal(visibleUsageHint("cswarm example [--first <x> | --second <y>] [--third]", ["first", "second", "third"]),
    "cswarm example [--first <x> | --second <y>] [--third]");
});

test("variant selectors are shared by dispatch and help, while force is not a selector", { timeout: 10_000 }, async () => {
  const source = await readFile(resolve("src/cli.ts"), "utf8");
  assert.match(source, /selectedVariants\(checkVariants, \(args\) => args\.has\(CHECK_MESSAGES_SELECTOR_FLAGS\[1\]\).*args\.has\(CHECK_MESSAGES_SELECTOR_FLAGS\[0\]\)/);
  assert.match(source, /selectedVariants\(inboxVariants, \(args\) => args\.has\(INBOX_READ_SELECTOR_FLAGS\[2\]\).*args\.has\(INBOX_READ_SELECTOR_FLAGS\[0\]\)/);
  assert.match(source, /args\.has\(INBOX_READ_SELECTOR_FLAGS\[1\]\)/);
  assert.match(source, /const CHECK_MESSAGE_HIDDEN_FLAGS = \["force"\]/);
  assert.doesNotMatch(source, /CHECK_MESSAGE_SELECTOR_FLAGS = [^\n]*force/);
  const check = AGENT_COMMANDS.check as AgentCommandEntry;
  const inbox = AGENT_COMMANDS.inbox as AgentCommandEntry;
  assert.equal(check.select(new cliAccepted.Arguments(["check", "--force"])), "messages");
  assert.equal(check.select(new cliAccepted.Arguments(["check", "--hook"])), "hook");
  assert.equal(inbox.select(new cliAccepted.Arguments(["inbox", "--follow"])), "follow");
  const checkSelectors = cliAccepted.CHECK_MESSAGES_SELECTOR_FLAGS as unknown as string[];
  const inboxSelectors = cliAccepted.INBOX_READ_SELECTOR_FLAGS as unknown as string[];
  const oldCheck = checkSelectors[1]!;
  const oldInbox = inboxSelectors[0]!;
  checkSelectors[1] = "full";
  inboxSelectors[0] = "include-stale";
  try {
    assert.equal(check.select(new cliAccepted.Arguments(["check", "--full"])), "hook");
    assert.equal(inbox.select(new cliAccepted.Arguments(["inbox", "--include-stale"])), "follow");
    assert.ok(!VARIANT_HELP_FLAGS["check.messages"]!.includes("full"));
    assert.ok(!VARIANT_HELP_FLAGS["inbox.read"]!.includes("include-stale"));
  } finally {
    checkSelectors[1] = oldCheck;
    inboxSelectors[0] = oldInbox;
  }
});

test("no unused parser option gate remains beside the help renderer", { timeout: 10_000 }, async () => {
  const source = await readFile(resolve("src/cli.ts"), "utf8");
  assert.doesNotMatch(source, /parseCommandOptions/);
});

test("every handler shape reads an exported accepted-flag constant", { timeout: 10_000 }, async () => {
  let count = 0;
  for (const file of ["src/cli.ts", "src/onboarding-cli.ts"]) {
    const source = ts.createSourceFile(file, await readFile(resolve(file), "utf8"), ts.ScriptTarget.Latest, true);
    const exports = new Set(source.statements.filter(ts.isVariableStatement)
      .filter(node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
      .flatMap(node => node.declarationList.declarations.map(declaration => declaration.name.getText(source))));
    const imported = new Set(source.statements.filter(ts.isImportDeclaration)
      .flatMap(node => node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        ? node.importClause.namedBindings.elements.map(element => element.name.text) : []));
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "args.assertShape") {
        count++;
        const shape = node.arguments[0]!;
        if (shape.getText(source) === "allowedFlags" && file === "src/cli.ts") {
          const body = source.getFullText();
          assert.match(body, /resolveSignalBody\(args, 1, allowedFlags\)/);
          assert.match(body, /resolveSignalBody\(args, 2, allowedFlags\)/);
          assert.match(body, /const allowedFlags = postSignalAllowedFlags\(kind\)/);
          assert.match(body, /const allowedFlags = replyAllowedFlags\(\)/);
          assert.match(body, /return kind === "working-on" \? POST_SIGNAL_WORKING_ON_ACCEPTED_FLAGS/);
          assert.match(body, /return REPLY_ACCEPTED_FLAGS/);
          ts.forEachChild(node, visit);
          return;
        }
        if (shape.getText(source) === "acceptedFlags" && file === "src/cli.ts") {
          const body = source.getFullText();
          assert.match(body, /fileContext\(args, FILE_PUT_ACCEPTED_FLAGS/);
          assert.match(body, /fileContext\(args, FILE_LS_ACCEPTED_FLAGS/);
          assert.match(body, /fileContext\(args, BRAIN_PUT_ACCEPTED_FLAGS/);
          assert.match(body, /fileContext\(args, FEEDBACK_ACCEPTED_FLAGS/);
          ts.forEachChild(node, visit);
          return;
        }
        const identifiers = [...shape.getText(source).matchAll(/\b[A-Z][A-Z0-9_]*_FLAGS\b/g)].map(match => match[0]);
        assert.ok(identifiers.length > 0, `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} has no accepted-flag constant`);
        for (const identifier of identifiers) assert.ok(exports.has(identifier) || imported.has(identifier), `${file} uses non-exported ${identifier}`);
        assert.ok(!/\[[^\]]*"[^"]+"/.test(shape.getText(source)), `${file} has copied literal shape ${shape.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.equal(count, 67, "the enumerated handler shape site count changed");
});

test("every help entry references a handler flag constant instead of a copied list", { timeout: 10_000 }, async () => {
  const source = ts.createSourceFile("src/cli.ts", await readFile(resolve("src/cli.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(item => item.name.getText(source) === "HANDLER_HELP_FLAGS");
  assert.ok(declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer));
  const rows = new Map(declaration.initializer.properties.filter((item): item is ts.PropertyAssignment | ts.GetAccessorDeclaration => ts.isPropertyAssignment(item) || ts.isGetAccessorDeclaration(item)).map(item => [
    item.name.getText(source).replace(/^"|"$/g, ""), ts.isPropertyAssignment(item) ? item.initializer.getText(source) : item.getText(source),
  ]));
  assert.deepEqual([...rows.keys()].sort(), entries().map(row => row.key).sort());
  for (const [key, value] of rows) {
    assert.match(value, /(?:ACCEPTED_FLAGS|CHECK_FLAGS|RECEIVE_COMMON_FLAGS)/, key);
    const property = declaration.initializer.properties.find(item => (ts.isPropertyAssignment(item) || ts.isGetAccessorDeclaration(item)) && item.name.getText(source).replace(/^"|"$/g, "") === key);
    assert.ok(property && (ts.isPropertyAssignment(property) || ts.isGetAccessorDeclaration(property)));
    const visit = (node: ts.Node): void => {
      assert.ok(!ts.isArrayLiteralExpression(node), `${key} must not contain an array literal`);
      assert.ok(!ts.isStringLiteral(node), `${key} must not copy a flag string literal`);
      ts.forEachChild(node, visit);
    };
    visit(ts.isPropertyAssignment(property) ? property.initializer : property.body!);
  }
});

test("variant help exclusions contain no inline flag literals", { timeout: 10_000 }, async () => {
  const source = ts.createSourceFile("src/cli.ts", await readFile(resolve("src/cli.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(item => item.name.getText(source) === "VARIANT_HELP_FLAGS");
  assert.ok(declaration?.initializer && ts.isObjectLiteralExpression(declaration.initializer));
  for (const property of declaration.initializer.properties) {
    assert.ok(ts.isPropertyAssignment(property) || ts.isGetAccessorDeclaration(property));
    const key = property.name.getText(source);
    const visit = (node: ts.Node): void => {
      assert.ok(!ts.isStringLiteral(node), `${key} must read a selector or refusal constant`);
      ts.forEachChild(node, visit);
    };
    visit(ts.isPropertyAssignment(property) ? property.initializer : property.body!);
  }
});

test("each direct help row names a constant read by its selected handler", { timeout: 10_000 }, async () => {
  const cli = ts.createSourceFile("src/cli.ts", await readFile(resolve("src/cli.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const onboarding = ts.createSourceFile("src/onboarding-cli.ts", await readFile(resolve("src/onboarding-cli.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = (name: string) => cli.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(item => item.name.getText(cli) === name);
  const commands = declaration("AGENT_COMMANDS");
  const help = declaration("HANDLER_HELP_FLAGS");
  assert.ok(commands?.initializer && ts.isObjectLiteralExpression(commands.initializer));
  assert.ok(help?.initializer && ts.isObjectLiteralExpression(help.initializer));
  const helpRows = new Map(help.initializer.properties.filter((item): item is ts.PropertyAssignment | ts.GetAccessorDeclaration => ts.isPropertyAssignment(item) || ts.isGetAccessorDeclaration(item))
    .map(item => [item.name.getText(cli).replace(/^"|"$/g, ""), ts.isPropertyAssignment(item) ? item.initializer.getText(cli) : item.getText(cli)]));
  const shapeReaders = (source: ts.SourceFile, name: string): string => {
    const functionNode = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    return functionNode?.getText(source) ?? "";
  };
  const selectedShapes: Record<string, readonly string[]> = {
    "hook.check": ["RUN_HOOK_1_ACCEPTED_FLAGS"],
    "hook.install": ["HOOK_INSTALL_ACCEPTED_FLAGS"],
    "hook.uninstall": ["HOOK_UNINSTALL_ACCEPTED_FLAGS"],
    "invite.create": ["RUN_INVITE_2_ACCEPTED_FLAGS"],
    "invite.revoke": ["RUN_INVITE_1_ACCEPTED_FLAGS"],
    "target.show": ["RUN_TARGET_1_ACCEPTED_FLAGS"],
    "target.set": ["RUN_TARGET_2_ACCEPTED_FLAGS"],
    "target.clear": ["RUN_TARGET_3_ACCEPTED_FLAGS"],
    "principal.create": ["RUN_PRINCIPAL_1_ACCEPTED_FLAGS"],
    "principal.revoke": ["RUN_PRINCIPAL_2_ACCEPTED_FLAGS"],
    "token.revoke": ["RUN_TOKEN_REVOKE_1_ACCEPTED_FLAGS", "RUN_TOKEN_REVOKE_2_ACCEPTED_FLAGS"],
    feedback: ["FEEDBACK_ACCEPTED_FLAGS"],
    "file.put": ["FILE_PUT_ACCEPTED_FLAGS"],
    "file.ls": ["FILE_LS_ACCEPTED_FLAGS"],
    "file.get": ["FILE_GET_ACCEPTED_FLAGS"],
    "file.rm": ["FILE_CONTEXT_BASE_ACCEPTED_FLAGS"],
    "file.restore": ["FILE_CONTEXT_BASE_ACCEPTED_FLAGS"],
    "brain.ls": ["FILE_CONTEXT_BASE_ACCEPTED_FLAGS"],
    "brain.get": ["BRAIN_GET_ACCEPTED_FLAGS"],
    "brain.put": ["BRAIN_PUT_ACCEPTED_FLAGS"],
    "working-on": ["POST_SIGNAL_WORKING_ON_ACCEPTED_FLAGS"],
    note: ["POST_SIGNAL_NOTE_ACCEPTED_FLAGS"],
    ask: ["POST_SIGNAL_ASK_ACCEPTED_FLAGS"],
    reply: ["REPLY_ACCEPTED_FLAGS"],
    feed: ["SIGNAL_READ_FEED_ACCEPTED_FLAGS"],
  };
  const variantGroups = new Set(["setup", "check", "resume", "inbox", "accept"]);
  const inspectEntry = (key: string, call: ts.CallExpression): void => {
    const config = call.arguments[0];
    assert.ok(config && ts.isObjectLiteralExpression(config), key);
    if (config.properties.some(item => ts.isSpreadAssignment(item) && item.expression.getText(cli).startsWith("selectedVariants("))) return;
    const handler = config.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(cli) === "handler");
    assert.ok(handler && ts.isPropertyAssignment(handler), `${key} has no handler`);
    const names = [...handler.initializer.getText(cli).matchAll(/\brun[A-Z][A-Za-z0-9]+\b/g)].map(match => match[0]!);
    const handlerName = names.at(-1);
    let body = handlerName ? shapeReaders(cli, handlerName) || shapeReaders(onboarding, handlerName) : handler.initializer.getText(cli);
    if (!body) body = handler.initializer.getText(cli);
    if (handlerName === "runPostSignal") body += shapeReaders(cli, "postSignalAllowedFlags");
    if (handlerName === "runReply") body += shapeReaders(cli, "replyAllowedFlags");
    if (key === "token.revoke") body += shapeReaders(cli, "runTokenRevoke");
    const flags = [...(helpRows.get(key) ?? "").matchAll(/\b[A-Z][A-Z0-9_]*_FLAGS\b/g)]
      .map(match => match[0]!).filter(flag => !flag.endsWith("REFUSED_FLAGS"));
    assert.ok(flags.length > 0, `${key} has no help shape constant`);
    for (const flag of flags) assert.match(body, new RegExp(`\\b${flag}\\b`), `${key} help uses ${flag} but ${handlerName ?? "inline handler"} does not`);
    if (!variantGroups.has(key)) {
      const reached = [...body.matchAll(/args\.assertShape\(\s*([A-Z][A-Z0-9_]*_FLAGS)\b/g)].map(match => match[1]!);
      const expected = selectedShapes[key] ?? [...new Set(reached)];
      assert.ok(expected.length > 0, `${key} has no selected handler shape`);
      assert.deepEqual([...new Set(flags)].sort(), [...new Set(expected)].sort(), `${key} help does not match its selected branch`);
    }
  };
  let checked = 0;
  for (const property of commands.initializer.properties.filter(ts.isPropertyAssignment)) {
    const verb = property.name.getText(cli).replace(/^"|"$/g, "");
    const value = property.initializer;
    if (!ts.isCallExpression(value)) continue;
    if (value.expression.getText(cli) === "commandEntry") {
      inspectEntry(verb, value);
      checked++;
    } else if (value.expression.getText(cli) === "group" && value.arguments[0] && ts.isObjectLiteralExpression(value.arguments[0])) {
      for (const child of value.arguments[0].properties.filter(ts.isPropertyAssignment)) {
        const action = child.name.getText(cli).replace(/^"|"$/g, "");
        if (ts.isCallExpression(child.initializer) && child.initializer.expression.getText(cli) === "commandEntry") {
          inspectEntry(`${verb}.${action}`, child.initializer);
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 67, "reconcile command table rows; dynamic session and selected variants have dedicated tests");
});

test("multi-action handlers select the direct help shape for their branch", { timeout: 10_000 }, async () => {
  const source = ts.createSourceFile("src/cli.ts", await readFile(resolve("src/cli.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const cases = [
    ["runInvite", 'args.positionals[1] === "revoke"', "RUN_INVITE_1_ACCEPTED_FLAGS"],
    ["runTarget", 'action === "show"', "RUN_TARGET_1_ACCEPTED_FLAGS"],
    ["runTarget", 'action === "set"', "RUN_TARGET_2_ACCEPTED_FLAGS"],
    ["runTarget", 'action === "clear"', "RUN_TARGET_3_ACCEPTED_FLAGS"],
    ["runPrincipal", 'action === "create"', "RUN_PRINCIPAL_1_ACCEPTED_FLAGS"],
    ["runPrincipal", 'action === "revoke"', "RUN_PRINCIPAL_2_ACCEPTED_FLAGS"],
    ["runHook", 'command === "check"', "RUN_HOOK_1_ACCEPTED_FLAGS"],
  ] as const;
  for (const [handler, predicate, shape] of cases) {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === handler);
    assert.ok(declaration && ts.isFunctionDeclaration(declaration));
    const branch = declaration.body?.statements.find(node => ts.isIfStatement(node) && node.expression.getText(source) === predicate);
    assert.ok(branch && ts.isIfStatement(branch), `${handler} has no ${predicate} branch`);
    const calls: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "args.assertShape") calls.push(node.arguments[0]?.getText(source) ?? "");
      ts.forEachChild(node, visit);
    };
    visit(branch.thenStatement);
    assert.deepEqual(calls, [shape], `${handler} ${predicate} selects the wrong shape`);
  }
  const invite = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "runInvite");
  assert.ok(invite && ts.isFunctionDeclaration(invite));
  assert.ok(invite.body?.statements.some(node => ts.isExpressionStatement(node) && node.getText(source).includes("args.assertShape(RUN_INVITE_2_ACCEPTED_FLAGS")), "invite create must select its shape after the revoke branch");
  assert.match(invite.getText(source), /if \(args\.positionals\[1\] === "revoke"\)[\s\S]*?return;\s*}\s*args\.assertShape\(RUN_INVITE_2_ACCEPTED_FLAGS/);
  const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "runHook");
  assert.ok(hook && ts.isFunctionDeclaration(hook));
  assert.match(hook.getText(source), /args\.assertShape\(command === "install" \? HOOK_INSTALL_ACCEPTED_FLAGS : HOOK_UNINSTALL_ACCEPTED_FLAGS/);
});

test("post-signal kind branches select the matching help shape", { timeout: 10_000 }, async () => {
  const source = ts.createSourceFile("src/cli.ts", await readFile(resolve("src/cli.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "postSignalAllowedFlags");
  assert.ok(declaration && ts.isFunctionDeclaration(declaration));
  const returned = declaration.body?.statements.find(ts.isReturnStatement)?.expression;
  assert.ok(returned && ts.isConditionalExpression(returned));
  assert.equal(returned.condition.getText(source), 'kind === "working-on"');
  assert.equal(returned.whenTrue.getText(source), "POST_SIGNAL_WORKING_ON_ACCEPTED_FLAGS");
  assert.ok(ts.isConditionalExpression(returned.whenFalse));
  assert.equal(returned.whenFalse.condition.getText(source), 'kind === "ask"');
  assert.equal(returned.whenFalse.whenTrue.getText(source), "POST_SIGNAL_ASK_ACCEPTED_FLAGS");
  assert.equal(returned.whenFalse.whenFalse.getText(source), "POST_SIGNAL_NOTE_ACCEPTED_FLAGS");
  for (const [kind, flags] of [
    ["working-on", cliAccepted.POST_SIGNAL_WORKING_ON_ACCEPTED_FLAGS],
    ["note", cliAccepted.POST_SIGNAL_NOTE_ACCEPTED_FLAGS],
    ["ask", cliAccepted.POST_SIGNAL_ASK_ACCEPTED_FLAGS],
  ] as const) assert.deepEqual(cliAccepted.postSignalAllowedFlags(kind), flags);
});

test("public route comment documents its function", { timeout: 10_000 }, async () => {
  const source = await readFile(resolve("src/cli.ts"), "utf8");
  assert.match(source, /export const LISTEN_START_REFUSED_FLAGS = [^\n]+;\s*\/\*\* Parse the public route before credentials or network work\. \*\/\s*export function listenerRouteConfiguration\(/);
});

test("handler help omits refused resume, dogfood and command flags", { timeout: 10_000 }, () => {
  const resume = commandHelpLines("resume");
  assert.doesNotMatch(resume, /--agent-token-stdin|--session-context/);
  assert.match(resume, /--state-dir/);
  const dogfood = commandHelpLines("dogfood");
  assert.doesNotMatch(dogfood, /--json|--session-context|--epoch|--to-owner|--grant-id|--disposition/);
  const command = commandHelpLines("command");
  assert.doesNotMatch(command, /--json/);
  assert.match(command, /--repo-mapping-id/);
  assert.doesNotMatch(commandHelpLines("session", "start"), /--agent-token-stdin/);
});

test("each enumerated help flag uses its command's enforcement parser", { timeout: 10_000 }, () => {
  const parsers: Record<string, Record<string, (value: string) => unknown>> = {
    "session.start": { mode: parseSessionMode, provider: parseSessionProvider },
    "receive.configure": { mode: parseReceiveMode, provider: parseReceiveProvider },
  };
  for (const [key, flags] of Object.entries(parsers)) {
    const [verb, action] = key.split(".");
    const section = commandHelpLines(verb, action);
    for (const [flag, parse] of Object.entries(flags)) {
      const match = section.match(new RegExp(`--${flag} (?:<)?([a-z|-]+)(?:>)?`));
      assert.ok(match, `${key} has no --${flag} enumeration`);
      const values = match[1]!.split("|");
      for (const value of values) assert.doesNotThrow(() => parse(value), `${key} --${flag} ${value}`);
      assert.throws(() => parse("not-rendered-control"), `${key} --${flag} accepted an unrendered value`);
    }
  }
});

test("session handler and help read the same accepted-flag constants", { timeout: 10_000 }, async () => {
  const source = await readFile(resolve("src/cli.ts"), "utf8");
  const ast = ts.createSourceFile("src/cli.ts", source, ts.ScriptTarget.Latest, true);
  let runSession: ts.FunctionDeclaration | undefined;
  ast.forEachChild(node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "runSession") runSession = node;
  });
  assert.ok(runSession);
  const shapes: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "args.assertShape") {
      shapes.push(node.arguments[0]!.getText(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(runSession);
  assert.deepEqual(shapes, [
    "SESSION_HUMAN_ACCEPTED_FLAGS",
    "args.hadProfileOption ? SESSION_PROFILE_STATUS_ACCEPTED_FLAGS : SESSION_STATUS_ACCEPTED_FLAGS",
    "args.hadProfileOption ? SESSION_PROFILE_STATUS_ACCEPTED_FLAGS : SESSION_STATUS_ACCEPTED_FLAGS",
    "SESSION_START_ACCEPTED_FLAGS",
  ]);
  const expected: Record<string, readonly string[]> = {
    start: [...SESSION_START_ACCEPTED_FLAGS.filter(flag => flag !== "agent-token-stdin"), "profile"],
    status: [...SESSION_PROFILE_STATUS_ACCEPTED_FLAGS, "profile"],
    stop: [...SESSION_PROFILE_STATUS_ACCEPTED_FLAGS, "profile"],
    enable: SESSION_HUMAN_ACCEPTED_FLAGS,
    disable: SESSION_HUMAN_ACCEPTED_FLAGS,
    recover: SESSION_HUMAN_ACCEPTED_FLAGS,
  };
  for (const [action, flags] of Object.entries(expected)) {
    const rendered = new Set([...commandHelpLines("session", action).matchAll(/--([a-z][a-z-]*)\b/g)].map(match => match[1]!));
    assert.deepEqual([...rendered].sort(), [...new Set(flags)].sort(), action);
  }
  assert.deepEqual(SESSION_STATUS_ACCEPTED_FLAGS.filter(flag => ["mode", "provider", "principal-id", "host-label", "foreground"].includes(flag)), []);
  const start = commandHelpLines("session", "start");
  assert.match(start, /cswarm session start[^\n]*--foreground/);
  assert.match(start, /cswarm session start[^\n]*--agent-token-file/);
  for (const action of ["enable", "disable", "recover"]) {
    assert.match(commandHelpLines("session", action), new RegExp(`cswarm session ${action}[^\\n]*\\[--workspace-id <uuid>\\]`));
  }
  for (const action of ["status", "stop"]) {
    assert.match(commandHelpLines("session", action), /\[--profile [^\n]*\[--workspace-id/);
  }
});

test("since guidance is one shared sentence for inbox, read and feed", { timeout: 10_000 }, () => {
  assert.equal(usage().split(SINCE_OFFSET_GUIDANCE).length - 1, 1);
  assert.match(commandHelpLines("inbox"), /--since/);
  assert.match(commandHelpLines("feed"), /--since/);
});

test("listen handler shapes and help share accepted flags including state-dir", { timeout: 10_000 }, async () => {
  const source = await readFile(resolve("src/cli.ts"), "utf8");
  assert.match(source, /handler: traced\("runListen", runListenStart\)[^\n]+flags: LISTEN_START_ACCEPTED_FLAGS/);
  assert.match(source, /handler: traced\("runListen", \(args\) => runListenStatusOrStop\(args, "status"\)\)[^\n]+flags: LISTEN_STATUS_ACCEPTED_FLAGS/);
  assert.match(source, /handler: traced\("runListen", \(args\) => runListenStatusOrStop\(args, "stop"\)\)[^\n]+flags: LISTEN_STATUS_ACCEPTED_FLAGS/);
  assert.match(source, /handler: traced\("runListen", runListenCanary\)[^\n]+flags: LISTEN_CANARY_ACCEPTED_FLAGS/);
  const ast = ts.createSourceFile("src/cli.ts", source, ts.ScriptTarget.Latest, true);
  for (const [name, constant] of [
    ["runListenStart", "LISTEN_START_ACCEPTED_FLAGS"],
    ["runListenStatusOrStop", "LISTEN_STATUS_ACCEPTED_FLAGS"],
    ["runListenCanary", "LISTEN_CANARY_ACCEPTED_FLAGS"],
  ]) {
    const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration && ts.isFunctionDeclaration(declaration));
    const calls: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "args.assertShape") calls.push(node.arguments[0]!.getText(ast));
      ts.forEachChild(node, visit);
    };
    visit(declaration);
    assert.deepEqual(calls, [constant], name);
  }
  for (const [action, flags] of [
    ["start", LISTEN_START_ACCEPTED_FLAGS.filter(flag => flag !== "defer-over")],
    ["status", LISTEN_STATUS_ACCEPTED_FLAGS],
    ["stop", LISTEN_STATUS_ACCEPTED_FLAGS],
    ["canary", LISTEN_CANARY_ACCEPTED_FLAGS],
  ] as const) {
    const rendered = new Set([...commandHelpLines("listen", action).matchAll(/--([a-z][a-z-]*)\b/g)].map(match => match[1]!));
    assert.deepEqual([...rendered].sort(), [...new Set([...flags, "profile"])].sort(), action);
  }
  assert.doesNotMatch(commandHelpLines("listen", "start"), /--session-context/);
});

test("provider, permissions and feedback kind help render enforcement values", { timeout: 10_000 }, async () => {
  const listen = commandHelpLines("listen", "start");
  const feedback = commandHelpLines("feedback");
  assert.match(listen, new RegExp(`--provider ${LISTENER_PROVIDERS.join("\\|")}`));
  assert.match(listen, new RegExp(`--permissions ${LISTENER_PERMISSION_MODES.join("\\|")}`));
  assert.match(feedback, new RegExp(`--kind ${FEEDBACK_KINDS.join("\\|")}`));
  for (const value of LISTENER_PERMISSION_MODES) assert.equal(listenerPermissionMode(value), value);
  assert.throws(() => listenerPermissionMode("not-rendered-control"));
  for (const value of SESSION_PROVIDERS) assert.equal(parseSessionProvider(value), value);
  assert.deepEqual(LISTENER_PROVIDERS, SESSION_PROVIDERS);
  for (const value of LISTENER_PROVIDERS) assert.equal(isListenerProvider(value), true);
  assert.equal(isListenerProvider("session-only-control"), false);
  assert.throws(() => parseSessionProvider("not-rendered-control"));
  const source = await readFile(resolve("src/cli.ts"), "utf8");
  assert.match(source, /FEEDBACK_KINDS as readonly string\[\]\)\.includes\(kind\)/);
  assert.match(source, /function listenerProvider\(args: Arguments\): ListenerProviderId \{[\s\S]*?isListenerProvider\(provider\)/);
  assert.match(source, /help: \[`cswarm listen start[^`]+--provider \$\{LISTENER_PROVIDERS\.join\("\|"\)\}/);
  assert.match(source, /help: \[`cswarm listen start[^`]+--permissions \$\{LISTENER_PERMISSION_MODES\.join\("\|"\)\}/);
  assert.match(source, /help: \[`cswarm feedback[^`]+--kind \$\{FEEDBACK_KINDS\.join\("\|"\)\}/);
});

test("route and purpose guidance reads enforcement constants", { timeout: 10_000 }, async () => {
  const source = await readFile(resolve("src/cli.ts"), "utf8");
  assert.match(source, /\[--route \$\{listenerRouteUsage\(\)\}\]/);
  assert.match(source, /purpose: at most \$\{CHANNEL_PURPOSE_MAX\} characters/);
  assert.ok(commandHelpLines("listen", "start").includes(`--route ${listenerRouteUsage()}`));
  assert.ok(commandHelpLines("channel", "create").includes(`${CHANNEL_PURPOSE_MAX} characters`));
});

test("inbox guidance has its own heading before credential selection", { timeout: 10_000 }, () => {
  const output = usage();
  const inbox = output.indexOf("Inbox paging:");
  const since = output.indexOf("inbox --since", inbox);
  const limit = output.indexOf("--limit may omit", inbox);
  const credentials = output.indexOf("Credential selection for command/dogfood:");
  assert.ok(inbox >= 0 && inbox < since && since < limit && limit < credentials);
});

test("every multi-variant entry has help for each selected command shape", { timeout: 10_000 }, () => {
  const multiVariantEntries = entries()
    .filter(({ entry }) => Object.keys(entry.variants).length > 1)
    .map(({ key }) => key)
    .sort();
  assert.deepEqual(Object.keys(SELECTED_VARIANT_HELP_SHAPES).sort(), multiVariantEntries);
  for (const { key, entry } of entries()) {
    if (Object.keys(entry.variants).length <= 1) continue;
    const shapes = SELECTED_VARIANT_HELP_SHAPES[key];
    assert.ok(shapes, `${key} has selected variants but no help-shape gate`);
    assert.deepEqual(Object.keys(shapes).sort(), Object.keys(entry.variants).sort(), `${key} help shapes do not cover its variants`);
    for (const [id, variant] of Object.entries(entry.variants)) {
      const shape = shapes[id];
      assert.ok(shape, `${key}.${id} has no distinguishing help shape`);
      assert.ok(
        variant.help.some(line => line.includes(shape)),
        `${key}.${id} help does not match its command shape: ${shape}`,
      );
    }
  }
});

type CommandPair = { verb: string; action?: string };

function namedCommandPairs(text: string): CommandPair[] {
  const pairs = new Map<string, CommandPair>();
  const valueFlags = new Set([
    "--profile", "--host-session-id", "--url", "--anon-key",
    "--workspace-id", "--agent-token-file",
  ]);
  const booleanFlags = new Set(["--json", "--agent-token-stdin"]);
  for (const match of text.matchAll(/\bcswarm[ \t]+([^\n`"';.]*)/g)) {
    const tokens = [...(match[1] ?? "").matchAll(/--[a-z][a-z-]*|<[^>]+>|[a-z][a-z-]*/g)]
      .map(token => token[0]);
    let index = 0;
    while (tokens[index]?.startsWith("--")) {
      const flag = tokens[index]!;
      index += valueFlags.has(flag) ? 2 : booleanFlags.has(flag) ? 1 : 2;
    }
    const verb = tokens[index];
    if (verb === undefined || verb.startsWith("<")) continue;
    const candidate = tokens[index + 1];
    const action = candidate === undefined || candidate.startsWith("--") || candidate.startsWith("<")
      ? undefined
      : candidate;
    const key = `${verb}\0${action ?? ""}`;
    pairs.set(key, action === undefined ? { verb } : { verb, action });
  }
  return [...pairs.values()];
}

function modelFacingCategory(entry: AgentCommandEntry): "tool" | "bootstrap" | null {
  if (entry.tool !== null) return "tool";
  if (entry.bootstrap) return "bootstrap";
  return null;
}

test("every model-facing command pair is a tool or a derived bootstrap entry", { timeout: 10_000 }, async () => {
  const surfaces = {
    AGENT_QUICK_GUIDE,
    "site/public/skills/cswarm/SKILL.md": await readFile(
      resolve("site/public/skills/cswarm/SKILL.md"),
      "utf8",
    ),
    "site/src/components/connect/agent-prompt.ts": await readFile(
      resolve("site/src/components/connect/agent-prompt.ts"),
      "utf8",
    ),
  };
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const { verb, action } of namedCommandPairs(text)) {
      const root = Object.hasOwn(AGENT_COMMANDS, verb) ? AGENT_COMMANDS[verb] : undefined;
      assert.ok(root, `${surface} names cswarm ${verb}, which is absent from AGENT_COMMANDS`);
      let entry: AgentCommandEntry;
      if (isGroup(root)) {
        assert.ok(action, `${surface} names grouped command cswarm ${verb} without a sub-action`);
        const selected = root.subcommands[action];
        assert.ok(selected, `${surface} names absent command pair cswarm ${verb} ${action}`);
        entry = selected;
      } else {
        entry = root;
      }
      assert.notEqual(
        modelFacingCategory(entry),
        null,
        `${surface} names cswarm ${verb}${action ? ` ${action}` : ""}, but that pair is neither a tool nor bootstrap`,
      );
    }
  }
});

test("file and brain puts are model tools on the stdio transport", { timeout: 10000 }, async () => {
  const command = "cswarm brain put <topic> <markdown-path>";
  const skill = await readFile(resolve("site/public/skills/cswarm/SKILL.md"), "utf8");
  assert.ok(AGENT_QUICK_GUIDE.includes(command), `AGENT_QUICK_GUIDE must name ${command}`);
  assert.ok(skill.includes(command), `site/public/skills/cswarm/SKILL.md must name ${command}`);

  const brain = AGENT_COMMANDS.brain;
  assert.ok(brain && isGroup(brain), "brain command group is missing");
  const put = brain.subcommands.put;
  assert.ok(put, "brain.put entry is missing");
  assert.equal(put.tool, "brain_put");
  const file = AGENT_COMMANDS.file;
  assert.ok(file && isGroup(file));
  assert.equal(file.subcommands.put.tool, "file_put");
  const served = entries().filter(({ entry }) => entry.mcp).map(({ entry }) => entry.tool).sort();
  const mcp = MCP_TOOLS.map(tool => tool.name).sort();
  assert.deepEqual(mcp, served, "the complete MCP tool set must match the command table's MCP entries");
  assert.ok(mcp.includes(put.tool));
  assert.ok(mcp.includes(file.subcommands.put.tool));
});

test("model-facing command parsing finds flags before a command pair", { timeout: 10_000 }, () => {
  assert.deepEqual(
    namedCommandPairs("Run cswarm --profile p token mint only when instructed."),
    [{ verb: "token", action: "mint" }],
  );
  assert.deepEqual(namedCommandPairs("Run npm test."), []);
});

test("tool metadata and flags are generated from entry policy", { timeout: 10_000 }, () => {
  for (const { key, entry } of entries(true)) {
    assert.equal(entry.argumentSchema.additionalProperties, false, `${key} schema must be closed`);
    if (entry.tool === null) {
      assert.equal(typeof entry.reason, "string", `${key} tool:null needs a reason`);
      assert.ok(entry.reason.trim().length > 0, `${key} tool:null reason is empty`);
    }
    assert.equal(new Set(entry.flags).size, entry.flags.length, `${key} repeats a flag`);
    if (entry.profile === "refuse") {
      assert.equal(entry.hostSessionId, "drop", `${key} refuses profile but keeps host session`);
      assert.equal(entry.flags.includes("profile"), false, `${key} refuses but advertises --profile`);
      assert.equal(entry.flags.includes("host-session-id"), false, `${key} refuses but advertises --host-session-id`);
    } else {
      assert.equal(entry.flags.includes("profile"), true, `${key} accepts but omits --profile`);
      assert.equal(entry.flags.includes("host-session-id"), true, `${key} accepts but omits --host-session-id`);
    }
    assert.deepEqual(
      Object.keys(entry.argumentSchema.properties).sort(),
      ["positionals", ...entry.flags].sort(),
      `${key} schema and flags differ`,
    );
  }
  for (const transport of ["stdio", "http"] as const) {
    const generated = agentToolsForTransport(transport);
    assert.equal(new Set(generated.map(tool => tool.name)).size, generated.length, `${transport} tool names repeat`);
    const expected = entries()
      .map(({ entry }) => entry)
      .filter(entry => entry.tool !== null && entry.transports.includes(transport))
      .map(entry => entry.tool)
      .sort();
    assert.deepEqual(generated.map(tool => tool.name).sort(), expected);
  }
  for (const toolName of ["ask", "note", "reply"]) {
    const tool = agentToolsForTransport("stdio").find(candidate => candidate.name === toolName);
    assert.ok(tool, `${toolName} tool is missing`);
    assert.equal(Object.hasOwn(tool.inputSchema.properties, "attach"), false);
  }
});

test("AGENT_PROFILE_COMMANDS is derived from table order data", { timeout: 10_000 }, () => {
  // Item I fold 3: an entry is a verb or a "verb action" pair; the verbs still follow profileListOrder.
  const expected = Object.entries(AGENT_COMMANDS)
    .map(([verb, root]) => ({ verb, order: root.profileListOrder }))
    .filter((row): row is { verb: string; order: number } => row.order !== undefined)
    .sort((left, right) => left.order - right.order)
    .map(row => row.verb);
  const entryVerbs = AGENT_PROFILE_COMMANDS.map(entry => entry.split(" ")[0]!);
  const verbs = entryVerbs.filter((verb, index, all) => all.indexOf(verb) === index);
  assert.deepEqual(verbs, expected);
  // Every entry, not only the first per verb, follows the order: a verb's pairs stay together in its slot.
  const orders = entryVerbs.map(verb => expected.indexOf(verb));
  assert.deepEqual(orders, [...orders].sort((left, right) => left - right));
});

test("main has one direct lookup and only allowlisted meta and selected-entry statements", { timeout: 10_000 }, async () => {
  const sourceText = await readFile(resolve("src/cli.ts"), "utf8");
  const source = ts.createSourceFile("src/cli.ts", sourceText, ts.ScriptTarget.Latest, true);
  const main = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "main"
  );
  assert.ok(main?.body, "main() is missing");

  const lookups: ts.ElementAccessExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) && node.expression.text === "AGENT_COMMANDS"
    ) lookups.push(node);
    ts.forEachChild(node, visit);
  };
  visit(main.body);
  assert.equal(lookups.length, 1, `main() must perform one AGENT_COMMANDS lookup; found ${lookups.length}`);

  const expectedSource = ts.createSourceFile("expected.ts", `
    selectedCommandContext = null;
    const firstArg = process.argv[2];
    if (firstArg === "--version" || firstArg === "-v") {
      process.stdout.write(\`cswarm \${CLI_BUILD_VERSION} (protocol \${CLIENT_PROTOCOL_VERSION})\\n\`);
      return;
    }
    const args = new Arguments(process.argv.slice(2));
    const verb = args.positionals[0];
    if (!verb || verb === "help" || args.has("help")) {
      if (verb === "help") args.assertShape(MAIN_1_ACCEPTED_FLAGS, 1);
      process.stdout.write(\`\${helpFor(verb, args.positionals[1])}\\n\`);
      return;
    }
    const root = Object.hasOwn(AGENT_COMMANDS, verb) ? AGENT_COMMANDS[verb] : undefined;
    if (root === undefined) {
      await args.expandAgentProfile("refuse", "drop");
      throw new UsageError(\`unknown command: \${verb}\`);
    }
    const entry = selectCommandEntry(root, args);
    const variant = selectCommandVariant(entry, args);
    selectedCommandContext = { entry, variant, args };
    await args.expandAgentProfile(entry.profile, entry.hostSessionId);
    await variant.handler(args);
  `, ts.ScriptTarget.Latest, true);
  const expected = expectedSource.statements;
  const actual = main.body.statements;
  assert.equal(actual.length, expected.length, `main() statement count changed: ${actual.length}`);
  const printer = ts.createPrinter({ removeComments: true });
  for (let index = 0; index < expected.length; index += 1) {
    const actualShape = printer.printNode(ts.EmitHint.Unspecified, actual[index]!, source);
    const expectedShape = printer.printNode(ts.EmitHint.Unspecified, expected[index]!, expectedSource);
    assert.equal(actualShape, expectedShape, `main() statement ${index + 1} is not allowlisted`);
  }
});

function functionBody(source: ts.SourceFile, name: string): ts.Block {
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  assert.ok(declaration?.body, `${name}() is missing`);
  return declaration.body;
}

function methodBody(source: ts.SourceFile, className: string, methodName: string): ts.Block {
  const declaration = source.statements.find((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === className
  );
  assert.ok(declaration, `${className} is missing`);
  const method = declaration.members.find((member): member is ts.MethodDeclaration =>
    ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === methodName
  );
  assert.ok(method?.body, `${className}.${methodName}() is missing`);
  return method.body;
}

function assertStatementAllowlist(
  source: ts.SourceFile,
  actual: ts.Block,
  expectedText: string,
  label: string,
): void {
  const expectedSource = ts.createSourceFile(`${label}.ts`, expectedText, ts.ScriptTarget.Latest, true);
  const expectedFunction = expectedSource.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement)
  );
  assert.ok(expectedFunction?.body, `${label} expected shape is missing`);
  assert.equal(actual.statements.length, expectedFunction.body.statements.length, `${label} statement count changed`);
  const printer = ts.createPrinter({ removeComments: true });
  for (let index = 0; index < actual.statements.length; index += 1) {
    assert.equal(
      printer.printNode(ts.EmitHint.Unspecified, actual.statements[index]!, source),
      printer.printNode(ts.EmitHint.Unspecified, expectedFunction.body.statements[index]!, expectedSource),
      `${label} statement ${index + 1} is not allowlisted`,
    );
  }
}

test("parsed-argument functions between lookup and handler are allowlisted", { timeout: 10_000 }, async () => {
  const sourceText = await readFile(resolve("src/cli.ts"), "utf8");
  const source = ts.createSourceFile("src/cli.ts", sourceText, ts.ScriptTarget.Latest, true);
  assertStatementAllowlist(source, functionBody(source, "selectCommandEntry"), `
    function expected(root: AgentCommandRoot, args: Arguments): AgentCommandEntry {
      if (!isCommandGroup(root)) return root;
      const action = root.choose(args);
      const entry = action !== undefined && Object.hasOwn(root.subcommands, action) ? root.subcommands[action] : undefined;
      return entry ?? root.refusal;
    }
  `, "selectCommandEntry");
  assertStatementAllowlist(source, functionBody(source, "selectCommandVariant"), `
    function expected(entry: AgentCommandEntry, args: Arguments): AgentCommandVariant {
      const id = entry.select(args);
      const variant = entry.variants[id];
      if (variant === undefined) {
        throw new Error(\`command select returned undeclared variant: \${id}\`);
      }
      return variant;
    }
  `, "selectCommandVariant");
  assertStatementAllowlist(source, methodBody(source, "Arguments", "expandAgentProfile"), `
    async function expected(
      profileMode: "refuse" | "native" | "expand",
      hostSessionId: "keep" | "drop",
    ): Promise<void> {
      const path = this.optional("profile");
      if (path === undefined) return;
      if (profileMode === "refuse") {
        throw new AgentSetupError("profile_command_invalid", \`--profile is supported by: \${AGENT_PROFILE_COMMANDS.join(", ")}.\`);
      }
      if (profileMode === "native") return;
      const conflicts = ["agent-token-file", "agent-token-stdin", "url", "anon-key", "workspace-id"].filter(flag => this.has(flag));
      if (conflicts.length > 0) throw new AgentSetupError("profile_flags_conflict", \`Do not combine --profile with \${conflicts.map(flag => \`--\${flag}\`).join(", ")}.\`);
      const profile = await readAgentProfile(path, this.optional("host-session-id"));
      await readProfileCredential(profile);
      this.expandedProfilePath = path;
      if (this.has("host-session-id") && hostSessionId === "drop") {
        const selected = await profileSessionContext(profile, this.required("host-session-id"));
        if (selected) {
          const explicit = this.optional("session-context");
          if (explicit !== undefined && resolve(explicit) !== resolve(selected.path)) throw new AgentSetupError("profile_session_conflict", "The supplied session context does not belong to this profile's host session.");
          if (explicit === undefined) this.push("session-context", selected.path);
        }
        this.flags.delete("host-session-id");
      }
      this.flags.delete("profile");
      for (const [flag, value] of [["agent-token-file", profile.credential_file], ["url", profile.url], ["anon-key", profile.anon_key], ["workspace-id", profile.workspace_id]]) this.push(flag!, value!);
    }
  `, "Arguments.expandAgentProfile");
  // Every table handler runs through traced(); a lookup or branch here would dispatch outside the table.
  assertStatementAllowlist(source, functionBody(source, "traced"), `
    function expected(handlerName: string, handler: AgentCommandHandler): AgentCommandHandler {
      return async (args) => {
        recordDispatch(handlerName);
        await handler(args);
      };
    }
  `, "traced");
});

test("the process entry only runs main(), and no top-level statement reads process.argv", { timeout: 10_000 }, async () => {
  const sourceText = await readFile(resolve("src/cli.ts"), "utf8");
  const source = ts.createSourceFile("src/cli.ts", sourceText, ts.ScriptTarget.Latest, true);
  const entries = source.statements.filter((statement): statement is ts.IfStatement =>
    ts.isIfStatement(statement) && ts.isCallExpression(statement.expression) &&
    ts.isIdentifier(statement.expression.expression) && statement.expression.expression.text === "isCliMain"
  );
  assert.equal(entries.length, 1, "src/cli.ts must have exactly one if (isCliMain()) entry");
  const body = entries[0]!.thenStatement;
  assert.ok(ts.isBlock(body), "the isCliMain() entry must be a block");
  assert.equal(body.statements.length, 1, "the isCliMain() entry must hold only main().catch(...)");
  const only = body.statements[0]!;
  const call = ts.isExpressionStatement(only) ? only.expression : undefined;
  assert.ok(
    call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "catch" && ts.isCallExpression(call.expression.expression) &&
      ts.isIdentifier(call.expression.expression.expression) && call.expression.expression.expression.text === "main" &&
      call.expression.expression.arguments.length === 0,
    "the isCliMain() entry must be main().catch(...)",
  );
  const readers = source.statements
    .filter(statement => !ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement))
    .filter(statement => /\bprocess\.argv\b/.test(statement.getText(source)))
    .map(statement => source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1);
  assert.deepEqual(readers, [], `top-level statements read process.argv at src/cli.ts lines ${readers.join(", ")}`);
});

function exportedRunOnboardingCommand(source: ts.SourceFile): ts.Node | undefined {
  const exported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
  return source.statements.find(statement => {
    if (ts.isFunctionDeclaration(statement)) {
      return exported(statement) && statement.name?.text === "runOnboardingCommand";
    }
    if (ts.isVariableStatement(statement) && exported(statement)) {
      return statement.declarationList.declarations.some(declaration =>
        bindingNames(declaration.name).includes("runOnboardingCommand")
      );
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
      return statement.exportClause.name.text === "runOnboardingCommand";
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      return statement.exportClause.elements.some(element =>
        element.name.text === "runOnboardingCommand" ||
        (element.name.text === "default" && element.propertyName?.text === "runOnboardingCommand")
      );
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      return statement.expression.text === "runOnboardingCommand";
    }
    return false;
  });
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

async function typeScriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await typeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("every export named runOnboardingCommand stays deleted", { timeout: 10_000 }, async () => {
  for (const path of await typeScriptFiles(resolve("src"))) {
    const sourceText = await readFile(path, "utf8");
    const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
    assert.equal(
      exportedRunOnboardingCommand(source) === undefined,
      true,
      `${path} exports deleted dispatcher runOnboardingCommand`,
    );
  }
});

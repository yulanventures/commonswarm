import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { MCP_TOOLS } from "../../src/mcp/tools.js";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  AGENT_COMMANDS,
  AGENT_PROFILE_COMMANDS,
  agentToolsForTransport,
  commandHelpLines,
  usage,
  type AgentCommandEntry,
  type AgentCommandGroup,
} from "../../src/cli.js";
import { AGENT_QUICK_GUIDE } from "../../src/cloud/agent-onboarding-contract.js";
import { onboardingUsage } from "../../src/onboarding-cli.js";

type EntryRow = { key: string; entry: AgentCommandEntry };

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
    assert.ok(section.startsWith("  cswarm "), `${key} has no synopsis`);
    assert.ok(section.includes(entry.description), `${key} has no description`);
    for (const flag of entry.flags) {
      assert.ok(section.includes(`--${flag}`), `${key} help omits --${flag}`);
    }
    for (const variant of Object.values(entry.variants)) {
      assert.ok(variant.help.length > 0, `${key}.${variant.id} has no variant synopsis`);
      for (const hint of variant.help) {
        assert.ok(section.includes(hint.split("  #")[0]!), `${key}.${variant.id} hint is absent`);
        for (const match of hint.matchAll(/--([a-z][a-z-]*)/g)) {
          assert.ok([...entry.flags, ...(entry.cliOnlyFlags ?? [])].includes(match[1]!), `${key}.${variant.id} help names unaccepted --${match[1]}`);
        }
      }
    }
    expected.push(section);
  }
  assert.equal(all, expected.join("\n"), "help has a command outside the table or omits one");
});

test("each visible verb and action answers scoped --help without contacting a deployment", { timeout: 60_000 }, () => {
  for (const { key, entry } of entries()) {
    if (!entry.visible) continue;
    const path = key.split(".");
    const run = spawnSync(process.execPath, ["dist/cli.js", ...path, "--url", "http://127.0.0.1:9", "--help"], {
      encoding: "utf8", timeout: 5_000,
    });
    assert.equal(run.status, 0, `${key}: ${run.stderr}`);
    assert.match(run.stdout, /^  cswarm /m, `${key} has no synopsis`);
    assert.ok(run.stdout.includes(entry.description), `${key} has no description`);
  }
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
      if (verb === "help") args.assertShape([], 1);
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

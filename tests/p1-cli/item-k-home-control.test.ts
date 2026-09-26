import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const riskyCalls = new Set(["saveAgentProfile", "setupAgent", "runAgentSetup", "connectMcp", "agentProfileRoot"]);
const expectedProfileTestFiles = [
  "agent-channel-grok-bot.test.ts", "agent-channel.test.ts", "agent-connection-token.test.ts",
  "agent-onboarding.test.ts", "command-dispatch-baseline.test.ts", "command-table-gates.test.ts",
  "item-i-profile-binding.test.ts",
  "mcp-connect.test.ts", "mcp-stdio.test.ts", "profile-ls.test.ts", "release-bundle.test.ts",
];

test("every profile-writing test call has a fixture HOME", { timeout: 10_000 }, async () => {
  async function files(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory()
      ? files(join(dir, entry.name)) : Promise.resolve(entry.name.endsWith(".test.ts") ? [join(dir, entry.name)] : [])))).flat();
  }
  const affected: string[] = [];
  const failures: string[] = [];
  for (const file of await files(resolve("tests"))) {
    const source = await readFile(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const imported = new Set<string>();
    for (const statement of tree.statements) {
      if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
        for (const element of statement.importClause.namedBindings.elements) {
          if (riskyCalls.has(element.propertyName?.text ?? element.name.text)) imported.add(element.name.text);
        }
      }
    }
    const testCalls: Array<{ name: string; body: ts.Node }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "test"
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const callback = node.arguments.at(-1);
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          testCalls.push({ name: node.arguments[0].text, body: callback.body });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    const fixture = tree.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "fixture");
    const fixtureHome = fixture && ts.isFunctionDeclaration(fixture)
      ? /process\.env\.HOME\s*=/.test(fixture.body?.getText(tree) ?? "") : false;
    const globalHome = tree.statements.some(statement => ts.isExpressionStatement(statement)
      && ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression)
      && statement.expression.expression.text === "before"
      && /process\.env\.HOME\s*=/.test(statement.expression.arguments.at(-1)?.getText(tree) ?? ""));
    let reached = false;
    const inspectSpawns = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && ["spawn", "spawnSync", "execFile", "execFileSync"].includes(node.expression.text)
        && /["'](?:setup|connect)["']/.test(node.getText(tree))) {
        reached = true;
        if (!globalHome && !/\bHOME\s*:/.test(node.getText(tree))) failures.push(`${file}: spawned setup/connect without child HOME`);
      }
      ts.forEachChild(node, inspectSpawns);
    };
    inspectSpawns(tree);
    // Dispatcher fixtures and the release-bundle helper pass command arrays to a
    // separate spawn call. Include those files even though the command is indirect.
    const indirectCli = /\[\s*["']setup["']\s*[,\]]|\[\s*["']mcp["']\s*,\s*["']connect["']/.test(source)
      && /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/.test(source);
    if (indirectCli) {
      reached = true;
      if (!globalHome && !/\bHOME\s*:/.test(source)) failures.push(`${file}: indirect setup/connect spawn without child HOME`);
    }
    for (const { name, body } of testCalls) {
      const bodyText = body.getText(tree);
      let directRisk = false;
      let firstRisk = Number.POSITIVE_INFINITY;
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && imported.has(node.expression.text)) {
          directRisk = true;
          firstRisk = Math.min(firstRisk, node.getStart(tree) - body.getStart(tree));
        }
        ts.forEachChild(node, walk);
      };
      walk(body);
      const cliRisk = /\b(?:cli|cliRaw)\s*\([^\n]*\[\s*["'](?:setup|mcp)["']/.test(bodyText);
      if (!directRisk && !cliRisk) continue;
      reached = true;
      const beforeRisk = bodyText.slice(0, firstRisk);
      const localHome = /process\.env\.HOME\s*=/.test(beforeRisk);
      const fixtureCall = fixtureHome && /\bawait\s+fixture\s*\(/.test(beforeRisk);
      const childHome = /HOME\s*:/.test(bodyText) || /function cliRaw\([\s\S]*?HOME\s*:/.test(source);
      if (directRisk && !(globalHome || localHome || fixtureCall) || cliRisk && !(globalHome || localHome || fixtureCall || childHome)) {
        failures.push(`${file}: ${name}`);
      }
    }
    if (imported.size > 0 || reached) affected.push(file.slice(resolve("tests/p1-cli").length + 1));
  }
  assert.deepEqual(affected.sort(), expectedProfileTestFiles.slice().sort(),
    "profile-writing test inventory changed; inspect each new path and its HOME fixture");
  assert.deepEqual(failures, [], `calls without fixture HOME: ${failures.join(", ")}`);
});

test("item K registry and credential checks use fixture homes and leave their enclosing HOME empty", { timeout: 60_000 }, async () => {
  const home = await mkdtemp("/tmp/lane-home.");
  const logs = await mkdtemp("/tmp/lane-home-spy.");
  const log = join(logs, "homedir.log");
  try {
    for (const [file, pattern] of [
      ["agent-onboarding.test.ts", "standalone checks drain tied timestamps"],
      ["mcp-connect.test.ts", "connect saves an unbound private profile"],
    ]) {
      const run = spawnSync(process.execPath, ["--require", resolve("tests/p1-cli/item-k-home-spy.cjs"),
        "--import", "tsx", "--test-isolation=none", "--test", `--test-name-pattern=${pattern}`,
        `tests/p1-cli/${file}`], {
        cwd: process.cwd(), env: { ...process.env, HOME: home, CSWARM_HOME_SPY_LOG: log },
        encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024,
      });
      assert.equal(run.status, 0, `${file}: ${run.error ?? run.stderr.slice(-1000)}\n${run.stdout.slice(-1000)}`);
      assert.match(run.stdout, /pass 1/, file);
      assert.deepEqual(await readdir(home), [], `${file} reached the enclosing HOME`);
    }
    const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean)
      .map(line => JSON.parse(line) as { path: string; stack: string });
    const builders = calls.filter(call => /agent-profile|agent-credential/.test(call.stack));
    assert.ok(builders.some(call => call.stack.includes("agent-profile")), "registry path builder was observed");
    // The check fixture sets SWARM_AGENT_STATE_DIR, so its credential builder does not call homedir().
    assert.ok(builders.every(call => call.path !== home && call.path !== userInfo().homedir),
      "a builder reached the enclosing or real home");
    assert.ok(builders.every(call => call.path.startsWith(join(tmpdir(), "cswarm-") ) || call.path.startsWith(join(tmpdir(), "lane-home-"))),
      "a builder escaped fixture homes");
  } finally { await rm(home, { recursive: true, force: true }); await rm(logs, { recursive: true, force: true }); }
});

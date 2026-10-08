import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const repoRoot = resolve(import.meta.dirname, "../..");
const launcher = join(repoRoot, "site/tests/chrome.ts");
const cdpLauncher = join(repoRoot, "tests/p1-local/human-seen-browser.test.ts");
const smokeLauncher = join(repoRoot, "scripts/smoke/smoke.mjs");
// Hash exact file bytes with: shasum -a 256 scripts/smoke/smoke.mjs
// Re-review against chrome.ts before updating this pin; AST assertions below are secondary checks.
const SMOKE_LAUNCHER_SHA256 = "600bd015c26db61582d7e0a5e109fe1a1d8f30df660aaf5369b71163cd599b17";
const smokePinMessage = "scripts/smoke/smoke.mjs changed: re-review its browser launch against site/tests/chrome.ts safety rules, then update SMOKE_LAUNCHER_SHA256";
const sourceRoots = ["src", "tests", "scripts", "site", "deploy", "services"];
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx", ".sh"]);
const browserFreeChecks = new Set([
  join(repoRoot, "site/tests/chrome-guard.test.ts"),
  join(repoRoot, "site/tests/chrome-launch-sweep.test.ts"),
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "dist-release", ".git"].includes(entry.name)) return [];
      return sourceFiles(path);
    }
    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
  }));
  return files.flat();
}

/** The plain-Node Linux smoke cannot import the TypeScript, test-gated launcher. */
function smokeLaunchViolations(source: string): string[] {
  const tree = ts.createSourceFile("smoke.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const launches: ts.CallExpression[] = [];
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && /^(?:launch|launchPersistentContext)$/u.test(node.expression.name.text)) launches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const compact = (node: ts.Node): string => node.getText(tree).replace(/\s+/gu, "").replace(/"/gu, "'");
  const launch = launches[0];
  if (launches.length !== 1 || !launch || compact(launch.expression) !== "chromium.launchPersistentContext") {
    return ["smoke must launch only one bundled Chromium context"];
  }
  const violations: string[] = [];
  const subprocessNames = new Set(["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"]);
  const launchNames = new Set(["launch", "launchPersistentContext"]);
  if (nodes.some((node) => ts.isElementAccessExpression(node)
    && ts.isStringLiteralLike(node.argumentExpression)
    && (launchNames.has(node.argumentExpression.text) || subprocessNames.has(node.argumentExpression.text)))) {
    violations.push("smoke must not use computed launch or subprocess access");
  }
  if (nodes.some((node) => {
    if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name;
      if ((ts.isIdentifier(name) || ts.isStringLiteralLike(name))
        && (subprocessNames.has(name.text) || launchNames.has(name.text))) return true;
    }
    if (ts.isIdentifier(node) && subprocessNames.has(node.text)) {
      const parent = node.parent;
      if (ts.isImportSpecifier(parent)) return !!parent.propertyName || parent.name.text !== "spawn";
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
      if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
      return !(ts.isCallExpression(parent) && parent.expression === node);
    }
    if (ts.isPropertyAccessExpression(node) && (subprocessNames.has(node.name.text)
      || (compact(node.expression) === "chromium" && launchNames.has(node.name.text)))) {
      return !(ts.isCallExpression(node.parent) && node.parent.expression === node);
    }
    return false;
  })) violations.push("smoke must not alias launch or subprocess functions");
  const subprocesses = nodes.filter((node): node is ts.CallExpression => ts.isCallExpression(node)
    && ((ts.isIdentifier(node.expression) && (subprocessNames.has(node.expression.text) || node.expression.text === "run"))
      || (ts.isPropertyAccessExpression(node.expression) && subprocessNames.has(node.expression.name.text))));
  // The only child process is the existing OP edit, with its fixed executable, arguments and options.
  const approvedOp = "spawn('op',['item','edit',item.id,'--vault','CommonSwarmSmoke','--template',secret('item-next.json')],{env:{...process.env,OP_SERVICE_ACCOUNT_TOKEN:fs.readFileSync(secret('op-token.txt'),'utf8')},stdio:['ignore',fd,err],})";
  if (subprocesses.length !== 1 || subprocesses.some((node) => compact(node) !== approvedOp)) {
    violations.push("smoke must not launch a browser subprocess outside Playwright");
  }
  const functionBody = (node: ts.Node): ts.Block | undefined => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isArrowFunction(parent)) {
        return parent.body && ts.isBlock(parent.body) ? parent.body : undefined;
      }
    }
    return undefined;
  };
  const launchBody = functionBody(launch);
  const main = tree.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "main");
  const mainBody = main?.body && main.body.pos < launch.pos && main.body.end > launch.end ? main.body : undefined;
  // Guards must be direct function-body statements, not matches in dead or conditional blocks.
  const beforeLaunch = (text: string, body: ts.Block | undefined): boolean => !!body?.statements.some((statement) =>
    statement.end < launch.pos && (ts.isExpressionStatement(statement) ? compact(statement.expression) === text
      : ts.isVariableStatement(statement) && !!(statement.declarationList.flags & ts.NodeFlags.Const)
        && statement.declarationList.declarations.length === 1 && compact(statement.declarationList.declarations[0]!) === text));
  for (const [label, text, body] of [
    ["Linux guard", "prerequisite(process.platform==='linux')", mainBody],
    ["Playwright cache prerequisite", "prerequisite(typeofprocess.env.PLAYWRIGHT_BROWSERS_PATH==='string'&&process.env.PLAYWRIGHT_BROWSERS_PATH.length>0)", launchBody],
    ["bundled executable", "executable=fs.realpathSync(chromium.executablePath())", launchBody],
    ["realpath cache containment", "must(executable.startsWith(fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH)+path.sep))", launchBody],
  ] as const) {
    if (!beforeLaunch(text, body)) violations.push(`smoke missing ${label}`);
  }
  if (nodes.filter((node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "executable").length !== 1
    || nodes.some((node) => ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === "executable"
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)) {
    violations.push("smoke bundled executable must not be shadowed or reassigned");
  }
  if (launch.arguments.length !== 2 || !launch.arguments[0]
    || compact(launch.arguments[0]) !== "fs.mkdtempSync(secret('profile-'))") {
    violations.push("smoke must create a fresh temporary profile");
  }
  const options = launch.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return [...violations, "smoke launch options must be explicit"];
  const properties = new Map<string, ts.Expression>();
  const allowedOptions = new Set(["headless", "executablePath", "args", "acceptDownloads", "viewport", "timeout", "serviceWorkers"]);
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)
      || !allowedOptions.has(property.name.text) || properties.has(property.name.text)) {
      violations.push("smoke launch must not select a channel, override its profile, or hide options");
    } else properties.set(property.name.text, property.initializer);
  }
  if (properties.get("headless")?.kind !== ts.SyntaxKind.TrueKeyword) violations.push("smoke must be headless");
  const executable = properties.get("executablePath");
  if (!executable || compact(executable) !== "executable") violations.push("smoke executable must be the checked bundled path");
  const args = properties.get("args");
  if (!args || !ts.isArrayLiteralExpression(args) || args.elements.length !== 3
    || !["--password-store=basic", "--use-mock-keychain", "--no-sandbox"]
      .every((flag) => args.elements.some((arg) => ts.isStringLiteral(arg) && arg.text === flag))) {
    violations.push("smoke must use only the shared password-store, mock-keychain and sandbox flags");
  }
  return violations;
}

function directLaunchViolations(file: string, bytes: string | Buffer): string[] {
  const source = bytes.toString();
  if (file === smokeLauncher) {
    const pinViolations = createHash("sha256").update(bytes).digest("hex") === SMOKE_LAUNCHER_SHA256 ? [] : [smokePinMessage];
    return [...pinViolations, ...smokeLaunchViolations(source)];
  }
  // The CDP test owns a long-lived process, but shares admission, realpath validation and flags.
  if (file === cdpLauncher && ["requireBrowserTests", "resolveChromePath", "buildChromeArgs"]
    .every((helper) => new RegExp(`\\b${helper}\\s*\\(`, "u").test(source))) return [];
  return ["direct launch must use site/tests/chrome.ts"];
}

/** Module evaluation must only register browser tests, never start their shared fixtures. */
function eagerBrowserSetup(source: string, browserImports: ReadonlySet<string>): string[] {
  const tree = ts.createSourceFile("observer.ts", source, ts.ScriptTarget.Latest, true);
  const unsafe = new Set(browserImports);
  const functions = new Map<string, ts.Node>();
  const aliases = new Map<string, string>();
  const unwrap = (node: ts.Node): ts.Node => ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node) || ts.isNonNullExpression(node) ? unwrap(node.expression) : node;
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      functions.set(node.name.text, node.body);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = unwrap(node.initializer);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) functions.set(node.name.text, value.body);
      // An alias of an imported fixture or setup helper is still browser setup.
      if (ts.isIdentifier(value)) aliases.set(node.name.text, value.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const setupCall = (node: ts.Node): boolean => {
    if (!ts.isCallExpression(node)) return false;
    const callee = unwrap(node.expression);
    return ts.isIdentifier(callee) ? unsafe.has(callee.text)
      : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && unsafe.has(callee.expression.text);
  };
  const containsSetup = (node: ts.Node): boolean => setupCall(node)
    || ts.forEachChild(node, containsSetup) === true;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, target] of aliases) {
      if (!unsafe.has(name) && unsafe.has(target)) {
        unsafe.add(name);
        changed = true;
      }
    }
    for (const [name, body] of functions) {
      if (!unsafe.has(name) && containsSetup(body)) {
        unsafe.add(name);
        changed = true;
      }
    }
  }
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    // Function declarations and lazy callbacks do nothing until called. Call arguments and
    // IIFEs are checked below, including Promise executors and .then() callbacks.
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      const registersTest = ts.isIdentifier(callee) && callee.text === "test";
      if (setupCall(node) || (!registersTest && containsSetup(node))) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
        const label = ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)
          ? "IIFE" : node.expression.getText(tree);
        violations.push(`line ${line + 1}: eager browser setup ${label}`);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return violations;
}

test("the sweep rejects eager setup but admits lazy setup inside browser callbacks", () => {
  const imports = new Set(["findChrome", "launchChrome", "renderFixture", "browser", "createServer", "build"]);
  const cases = [
    ["top-level await", "await findChrome();", true],
    ["eager promise", "const pending = findChrome();", true],
    ["IIFE", "const pending = (async () => { await launchChrome(); })();", true],
    ["imported fixture", "const pending = renderFixture();", true],
    ["helper chain", "const start = () => findChrome(); const measure = () => start(); const pending = measure();", true],
    ["alias", "const start = findChrome; const pending = start();", true],
    ["local helper alias", "const start = () => findChrome(); const alias = start; alias();", true],
    ["namespace import", "const pending = browser.findChrome();", true],
    ["Promise executor", "const pending = new Promise(() => { findChrome(); });", true],
    ["scheduled callback", "Promise.resolve().then(() => findChrome());", true],
    ["eager test argument", 'test("case", { setup: findChrome() }, async () => {});', true],
    ["fixture server", "const server = createServer(); server.listen(0);", true],
    ["eager bundle", "const bundle = build({ write: false });", true],
    ["lazy cached fixture", 'let pending; const fixture = () => pending ??= renderFixture(); test("case", async () => { await fixture(); });', false],
    ["inert source text", 'const html = `findChrome()`; // await launchChrome();', false],
  ] as const;
  for (const [name, source, rejected] of cases) {
    assert.equal(eagerBrowserSetup(source, imports).length > 0, rejected, name);
  }
});

test("the smoke exception admits only its exact path and rejects unsafe launch variants", async (t) => {
  const bytes = await readFile(smokeLauncher);
  const source = bytes.toString("utf8");
  await t.test("current smoke is the positive control", () => {
    assert.deepEqual(directLaunchViolations(smokeLauncher, bytes), []);
  });
  await t.test("one character change requires launcher re-review even when properties remain safe", () => {
    const variant = source.replace("CommonSwarm smoke test.", "CommonSwarm smoke test!");
    assert.equal(variant.length, source.length);
    assert.equal([...source].filter((character, index) => character !== variant[index]).length, 1);
    assert.deepEqual(smokeLaunchViolations(variant), []);
    assert.deepEqual(directLaunchViolations(smokeLauncher, Buffer.from(variant)), [smokePinMessage]);
  });
  const cases = [
    ["installed Chrome channel", "headless: true,", 'headless: true, channel: "chrome",', "must not select a channel"],
    ["installed executable", "executablePath: executable", 'executablePath: "/usr/bin/google-chrome"', "checked bundled path"],
    ["missing Linux guard", "prerequisite(process.platform === 'linux');", "", "Linux guard"],
    ["reused profile", "fs.mkdtempSync(secret('profile-'))", '"/home/user/.config/google-chrome"', "fresh temporary profile"],
    ["headed browser", "headless: true", "headless: false", "must be headless"],
    ["missing cache prerequisite", "prerequisite(typeof process.env.PLAYWRIGHT_BROWSERS_PATH === 'string' && process.env.PLAYWRIGHT_BROWSERS_PATH.length > 0);", "", "cache prerequisite"],
    ["missing realpath containment", "must(executable.startsWith(fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH) + path.sep));", "", "realpath cache containment"],
    ["installed path derivation", "fs.realpathSync(chromium.executablePath())", "fs.realpathSync('/usr/bin/google-chrome')", "bundled executable"],
    ["missing mock keychain", "'--use-mock-keychain', ", "", "shared password-store"],
    ["hidden launch options", "headless: true,", "...overrides, headless: true,", "hide options"],
    ["additional launch", "liveContext = context;", "await chromium.launch({ channel: 'chrome' }); liveContext = context;", "only one bundled Chromium context"],
    ["installed browser subprocess", "liveContext = context;", "spawn('/usr/bin/google-chrome', []); liveContext = context;", "browser subprocess outside Playwright"],
    ["dead Linux guard", "prerequisite(process.platform === 'linux');", "if (false) { prerequisite(process.platform === 'linux'); }", "Linux guard"],
    ["dead containment check", "must(executable.startsWith(fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH) + path.sep));", "if (false) { must(executable.startsWith(fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH) + path.sep)); }", "realpath cache containment"],
    ["dead safe declaration shadowed by installed executable", "const executable = fs.realpathSync(chromium.executablePath());\n    must(executable.startsWith(fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH) + path.sep));", "if (false) { const executable = fs.realpathSync(chromium.executablePath()); must(executable.startsWith(fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH) + path.sep)); } const executable = fs.realpathSync('/usr/bin/google-chrome');", "bundled executable"],
    ["computed Chromium launch", "liveContext = context;", "await chromium['launch']({ channel: 'chrome' }); liveContext = context;", "computed launch or subprocess access"],
    ["aliased spawn", "liveContext = context;", "const startBrowser = spawn; startBrowser('/usr/bin/google-chrome', []); liveContext = context;", "alias launch or subprocess functions"],
    ["aliased Chromium launch", "liveContext = context;", "const startBrowser = chromium.launch; await startBrowser({ channel: 'chrome' }); liveContext = context;", "alias launch or subprocess functions"],
    ["namespace subprocess", "liveContext = context;", "child_process.execFile('/usr/bin/google-chrome', []); liveContext = context;", "browser subprocess outside Playwright"],
    ["subprocess alias assignment", "liveContext = context;", "let startBrowser; startBrowser = spawn; startBrowser('/usr/bin/google-chrome', []); liveContext = context;", "alias launch or subprocess functions"],
    ["destructured subprocess alias", "liveContext = context;", "const { spawn: startBrowser } = child_process; startBrowser('/usr/bin/google-chrome', []); liveContext = context;", "alias launch or subprocess functions"],
    ["destructured Chromium launch alias", "liveContext = context;", "const { launch: startBrowser } = chromium; await startBrowser({ channel: 'chrome' }); liveContext = context;", "alias launch or subprocess functions"],
    ["reassigned executable", "const executable = fs.realpathSync(chromium.executablePath());\n    must(executable.startsWith(fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH) + path.sep));", "let executable = fs.realpathSync(chromium.executablePath());\n    must(executable.startsWith(fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH) + path.sep)); executable = '/usr/bin/google-chrome';", "must not be shadowed or reassigned"],
  ] as const;
  for (const [name, from, to, reason] of cases) {
    await t.test(name, () => {
      const variant = source.replace(from, to);
      assert.notEqual(variant, source, "negative control must change the real smoke source");
      const violations = directLaunchViolations(smokeLauncher, variant);
      assert.ok(violations.includes(smokePinMessage), "every source edit must fail the content pin");
      assert.ok(violations.some((violation) => violation.includes(reason)), reason);
    });
  }
  for (const method of ["launch", "launchPersistentContext", "spawn", "exec", "execFile", "fork"]) {
    await t.test(`computed ${method} on another object`, () => {
      const variant = source.replace("liveContext = context;", `other['${method}'](); liveContext = context;`);
      assert.notEqual(variant, source);
      const violations = directLaunchViolations(smokeLauncher, variant);
      assert.ok(violations.includes(smokePinMessage));
      assert.ok(violations.includes("smoke must not use computed launch or subprocess access"));
    });
  }
  await t.test("another file cannot use the smoke exception", () => {
    assert.deepEqual(directLaunchViolations(join(repoRoot, "scripts/smoke/other.mjs"), source),
      ["direct launch must use site/tests/chrome.ts"]);
  });
});

test("repository browser launches use the shared safety helpers and gated test registration", async () => {
  const sourceBytes = new Map(await Promise.all(
    (await Promise.all(sourceRoots.map((root) => sourceFiles(join(repoRoot, root))))).flat()
      .filter((file) => file !== launcher && !browserFreeChecks.has(file))
      .map(async (file) => [file, await readFile(file)] as const),
  ));
  const sources = new Map([...sourceBytes].map(([file, bytes]) => [file, bytes.toString("utf8")] as const));
  const browserFiles = new Set<string>();
  const violations: string[] = [];
  for (const [file, source] of sources) {
    const hasHeadlessFlag = /["']--headless(?:=|["'])/u.test(source);
    const launchesChrome = /\b(?:execFile|spawn|run)\s*\(\s*(?:await\s+)?(?:\w*chrome\w*|["'][^"']*(?:chrome|chromium)[^"']*["'])/iu.test(source);
    const launchesBrowserLibrary = /\b(?:chromium|puppeteer|browserType)\s*\.\s*launch(?:PersistentContext)?\s*\(/u.test(source);
    // Check smoke's exact bytes even if an edit removes every recognized launch pattern.
    if (file === smokeLauncher || hasHeadlessFlag || launchesChrome || launchesBrowserLibrary) {
      browserFiles.add(file);
      violations.push(...directLaunchViolations(file, sourceBytes.get(file)!)
        .map((violation) => `${relative(repoRoot, file)}: ${violation}`));
    }
    if (/\b(?:findChrome|launchChrome)\b/u.test(source)) browserFiles.add(file);
  }
  // Follow relative imports to catch indirect browser use through any current or future fixture.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, source] of sources) {
      if (browserFiles.has(file)) continue;
      const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/gu)];
      if (imports.some((match) => {
        const dependency = resolve(file, "..", match[1]!);
        return [dependency, dependency.replace(/\.js$/u, ".ts"), `${dependency}.ts`]
          .some((path) => browserFiles.has(path));
      })) {
        browserFiles.add(file);
        changed = true;
      }
    }
  }
  for (const file of browserFiles) {
    const source = sources.get(file)!;
    if (!/\.(?:test|observer)\.(?:ts|js|mjs)$/u.test(file)) continue;
    const gatedRegistration = /import\s*\{\s*browserTest\s+as\s+test\s*\}\s*from\s*["'][^"']*\/tests\/chrome\.js["']/u.test(source);
    const ungatedRegistration = /\bfrom\s*["']node:test["']/u.test(source);
    if (!gatedRegistration || ungatedRegistration) {
      violations.push(`${relative(repoRoot, file)}: browser cases must use browserTest as test`);
    }
  }
  // Scan fixtures too: an imported module can start setup before its observer registers tests.
  for (const file of browserFiles) {
    const source = sources.get(file)!;
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const browserImports = new Set<string>();
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const setupImports = specifier === "node:http" ? ["createServer"]
        : specifier === "node:fs/promises" ? ["mkdtemp"]
          : specifier === "esbuild" ? ["build"] : [];
      const dependency = resolve(file, "..", specifier);
      const isLauncher = dependency.replace(/\.js$/u, ".ts") === launcher;
      if (!setupImports.length && !isLauncher && ![dependency, dependency.replace(/\.js$/u, ".ts"), `${dependency}.ts`]
        .some((path) => browserFiles.has(path))) continue;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          const imported = (binding.propertyName ?? binding.name).text;
          const setup = setupImports.length ? setupImports.includes(imported)
            : !isLauncher || ["findChrome", "launchChrome", "requireBrowserTests", "resolveChromePath"].includes(imported);
          if (setup) browserImports.add(binding.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        browserImports.add(bindings.name.text);
      }
      if (statement.importClause?.name) browserImports.add(statement.importClause.name.text);
    }
    violations.push(...eagerBrowserSetup(source, browserImports)
      .map((violation) => `${relative(repoRoot, file)}: ${violation}`));
  }
  assert.ok(browserFiles.size > 0, "the sweep must find browser callers");
  assert.deepEqual(violations, [], `browser safety violations:\n${violations.join("\n")}`);
});

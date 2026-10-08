import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const repoRoot = resolve(import.meta.dirname, "../..");
const launcher = join(repoRoot, "site/tests/chrome.ts");
const cdpLauncher = join(repoRoot, "tests/p1-local/human-seen-browser.test.ts");
const smokeLauncher = join(repoRoot, "scripts/smoke/smoke.mjs");
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
  if (nodes.some((node) => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && /^(?:execFile|spawn|run)$/u.test(node.expression.text) && node.arguments[0]
    && /chrome|chromium/iu.test(node.arguments[0].getText(tree)))) {
    violations.push("smoke must not launch a browser subprocess outside Playwright");
  }
  const beforeLaunch = (text: string): boolean => nodes.some((node) => node.end < launch.pos && compact(node) === text);
  for (const [label, text] of [
    ["Linux guard", "prerequisite(process.platform==='linux')"],
    ["Playwright cache prerequisite", "prerequisite(typeofprocess.env.PLAYWRIGHT_BROWSERS_PATH==='string'&&process.env.PLAYWRIGHT_BROWSERS_PATH.length>0)"],
    ["bundled executable", "executable=fs.realpathSync(chromium.executablePath())"],
    ["realpath cache containment", "must(executable.startsWith(fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH)+path.sep))"],
  ]) {
    if (!beforeLaunch(text!)) violations.push(`smoke missing ${label}`);
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

function directLaunchViolations(file: string, source: string): string[] {
  if (file === smokeLauncher) return smokeLaunchViolations(source);
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
  const source = await readFile(smokeLauncher, "utf8");
  await t.test("current smoke is the positive control", () => {
    assert.deepEqual(directLaunchViolations(smokeLauncher, source), []);
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
  ] as const;
  for (const [name, from, to, reason] of cases) {
    await t.test(name, () => {
      const variant = source.replace(from, to);
      assert.notEqual(variant, source, "negative control must change the real smoke source");
      assert.ok(directLaunchViolations(smokeLauncher, variant).some((violation) => violation.includes(reason)), reason);
    });
  }
  await t.test("another file cannot use the smoke exception", () => {
    assert.deepEqual(directLaunchViolations(join(repoRoot, "scripts/smoke/other.mjs"), source),
      ["direct launch must use site/tests/chrome.ts"]);
  });
});

test("repository browser launches use the shared safety helpers and gated test registration", async () => {
  const sources = new Map(await Promise.all(
    (await Promise.all(sourceRoots.map((root) => sourceFiles(join(repoRoot, root))))).flat()
      .filter((file) => file !== launcher && !browserFreeChecks.has(file))
      .map(async (file) => [file, await readFile(file, "utf8")] as const),
  ));
  const browserFiles = new Set<string>();
  const violations: string[] = [];
  for (const [file, source] of sources) {
    const hasHeadlessFlag = /["']--headless(?:=|["'])/u.test(source);
    const launchesChrome = /\b(?:execFile|spawn|run)\s*\(\s*(?:await\s+)?(?:\w*chrome\w*|["'][^"']*(?:chrome|chromium)[^"']*["'])/iu.test(source);
    const launchesBrowserLibrary = /\b(?:chromium|puppeteer|browserType)\s*\.\s*launch(?:PersistentContext)?\s*\(/u.test(source);
    if (hasHeadlessFlag || launchesChrome || launchesBrowserLibrary) {
      browserFiles.add(file);
      violations.push(...directLaunchViolations(file, source)
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

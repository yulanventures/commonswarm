import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const banned = /\b(?:online|offline|seat|grant|wake|token|OAuth|principal)\b|\bturn\b(?!\s+(?:on|off)\b)/iu;
function userStrings(source: string): string[] {
  const file = ts.createSourceFile("home.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result: string[] = [];
  const visit = (node: ts.Node) => {
    // Types, import paths and property identifiers are not screen copy.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node)) return;
    if (ts.isStringLiteralLike(node)) {
      if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
      result.push(node.text);
    }
    if (ts.isTemplateExpression(node)) {
      result.push(node.head.text, ...node.templateSpans.map(span => span.literal.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(file); return result;
}

test("home modules keep internal terms out of screen strings", async () => {
  const lib = new URL("../../lib/", import.meta.url);
  const files = (await readdir(lib)).filter(name => /^home-.*\.ts$/u.test(name)).sort();
  assert.ok(files.includes("home-primitives.ts") && files.includes("home-names.ts"));
  for (const file of files) {
    const strings = userStrings(await readFile(new URL(file, lib), "utf8"));
    assert.deepEqual(strings.filter(value => banned.test(value)), [], file);
  }
  const control = userStrings('import { token } from "./token"; type T = "seat"; const principal = 1; const title = "Turn the token offline"; const okay = `Start now ${principal}`;');
  assert.deepEqual(control.filter(value => banned.test(value)), ["Turn the token offline"]);
  assert.deepEqual(userStrings('const turn = 1; const copy = "Return to Home";').filter(value => banned.test(value)), []);
});

test("plain turn on/off verbs are allowed; the internal concept is not", () => {
  const strings = userStrings('const a = "Turn on Lists & docs"; const b = "Turn off this key"; const c = "turn-only"; const d = "per turn"; const e = "a turn"; const f = "each turn";');
  assert.deepEqual(strings.filter(value => banned.test(value)), ["turn-only", "per turn", "a turn", "each turn"]);
});

// Astro's script is outside the scoped tsc gate; parsing catches integration syntax failures.
test("the integrated dashboard script parses as TypeScript", async () => {
  const source = await readFile(new URL("LiveDashboard.astro", import.meta.url), "utf8");
  const script = source.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script, "dashboard script is present");
  const file = ts.createSourceFile("LiveDashboard.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  assert.deepEqual(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n")), []);
});


import { runInNewContext } from "node:vm";
import { resolveHomeRoute } from "../../lib/home-map";
import { routeHref } from "../../lib/home-route";

test("Catch up navigation keeps the signed-in account name after the workspace privacy reset", async () => {
  const dashboard = await readFile(new URL("LiveDashboard.astro", import.meta.url), "utf8");
  const file = ts.createSourceFile("dashboard.ts", dashboard.match(/<script>([\s\S]*?)<\/script>/u)![1], ts.ScriptTarget.Latest, true);
  let navigation: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "navigateHome") navigation = node;
    ts.forEachChild(node, visit);
  };
  visit(file); assert.ok(navigation);
  const targets = [{ textContent: "Zoe" }, { textContent: "Zoe" }];
  const memberships = [{ id: "W", name: "Home" }, { id: "X", name: "Trip" }];
  const calls: string[] = [];
  const context: Record<string, unknown> = { session: { user: { id: "zoe" } }, sampleMode: false,
    workspaces: memberships, homeRoute: { view: "chat", workspaceId: "W" }, homeScroll: new Map(), activeWorkspaceId: "W", homeNavigation: 0, catchUpGeneration: 0, requestVersion: 0,
    keepConnectCredentialVisible: () => false, resolveHomeRoute, routeHref, URL, one: () => null, all: () => targets,
    window: { location: { origin: "https://example.test" }, history: { state: { home: true }, pushState: () => {}, replaceState: () => {} } },
    closeEntityPanel: () => {}, closeRosterDialog: () => {}, closeWorkspaceDetailsDialog: () => {}, resetComposer: () => {},
    resetWorkspaceSessionState: () => { calls.push("reset"); for (const target of targets) target.textContent = "Your account"; context.workspaces = []; },
    accountName: () => { calls.push("account"); return "Zoe"; }, showPanel: () => {}, renderHomeShell: () => {}, applyRoute: () => {}, channelOverlay: null,
    focusHomeView: () => {}, loadHomeCatchUp: () => { calls.push("reads"); } };
  const script = ts.transpile(`const ${navigation.getText(file)}; navigateHome({view:"catchup"}, "push");`, { target: ts.ScriptTarget.ES2022 });
  await runInNewContext(script, context);
  assert.deepEqual(targets.map(target => target.textContent), ["Zoe", "Zoe"]);
  assert.equal(context.workspaces, memberships);
  assert.equal(calls[0], "reset");
  assert.equal(calls.at(-1), "reads", "the account identity is restored before Catch up reads start");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const builder = join(root, "scripts/build-chatgpt-package.sh");
const temporaryPrefix = join(tmpdir(), "chatgpt-package-test.");

function fixture(run) {
  const temporaryRoot = mkdtempSync(temporaryPrefix);
  try {
    const source = join(temporaryRoot, "package");
    cpSync(join(root, "distribution/chatgpt-apps"), source, { recursive: true });
    const invoke = (...args) => spawnSync("bash", [builder, "--package-dir", source, ...args], { cwd: root, encoding: "utf8" });
    const mutate = (name, change) => {
      const path = join(source, `${name}.json`);
      const json = JSON.parse(readFileSync(path, "utf8"));
      change(json);
      writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
    };
    run({ temporaryRoot, source, invoke, mutate });
  } finally {
    // Use the installed guarded rm, and only the absolute root created here.
    assert.ok(temporaryRoot.startsWith(temporaryPrefix));
    const cleanup = spawnSync("rm", ["-rf", temporaryRoot], { encoding: "utf8" });
    assert.equal(cleanup.status, 0, `guarded cleanup refused ${temporaryRoot}: ${cleanup.stderr}`);
  }
}

test("OA-01/OA-12: reject extra servers, app references, hooks, and private reviewer fields", () => {
  const mutations = [
    ["mcp", (mcp) => { mcp.mcpServers.extra = { type: "streamable-http", url: "https://example.com/mcp" }; }, /only the hosted/],
    ["mcp", (mcp) => { mcp.mcpServers.commonswarm.url = "https://example.com/mcp"; }, /only the hosted/],
    ["plugin", (plugin) => { plugin.extensions["com.openai"].apps = "./.app.json"; }, /no apps or hooks/],
    ["plugin", (plugin) => { plugin.extensions["com.openai"].hooks = "./hooks/hooks.json"; }, /no apps or hooks/],
    ["plugin", (plugin) => { plugin.extensions["com.openai"].review.test_credentials = "synthetic forbidden field"; }, /credentials and reviewer instructions/],
    ["plugin", (plugin) => { plugin.extensions["com.openai"].interface.supportURL = "http://commonswarm.com/support"; }, /supportURL: expected HTTPS URL/],
  ];
  for (const [name, mutation, reason] of mutations) {
    fixture(({ invoke, mutate }) => {
      assert.equal(invoke("--validate-only").status, 0);
      mutate(name, mutation);
      const rejected = invoke("--validate-only");
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, reason);
    });
  }
  fixture(({ source, invoke }) => {
    assert.equal(invoke("--validate-only").status, 0);
    writeFileSync(join(source, ".app.json"), "{}");
    const rejected = invoke("--validate-only");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /source inventory/);
  });
});

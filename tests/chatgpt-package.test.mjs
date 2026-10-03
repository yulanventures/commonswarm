import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const builder = join(root, "scripts/build-chatgpt-package.sh");

function fixture(run) {
  const temporaryRoot = mkdtempSync("/private/tmp/chatgpt-package-test.");
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
    assert.ok(temporaryRoot.startsWith("/private/tmp/chatgpt-package-test."));
    const cleanup = spawnSync("rm", ["-rf", temporaryRoot], { encoding: "utf8" });
    assert.equal(cleanup.status, 0, `guarded cleanup refused ${temporaryRoot}: ${cleanup.stderr}`);
  }
}

test("OA-01: portable schemas reject missing required fields and invalid field types after a positive control", () => {
  fixture(({ invoke, mutate }) => {
    assert.equal(invoke("--validate-only").status, 0);
    mutate("plugin", (plugin) => { delete plugin.name; });
    const missing = invoke("--validate-only");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /'name' is a required property/);
  });
  fixture(({ invoke, mutate }) => {
    assert.equal(invoke("--validate-only").status, 0);
    mutate("plugin", (plugin) => { plugin.author.name = 42; });
    const invalid = invoke("--validate-only");
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /not of type 'string'/);
  });
});

test("OA-01/OA-12: reject extra servers, app references, hooks, and private reviewer fields", () => {
  const mutations = [
    ["mcp", (mcp) => { mcp.mcpServers.extra = { type: "streamable-http", url: "https://example.com/mcp" }; }, /only the hosted/],
    ["mcp", (mcp) => { mcp.mcpServers.commonswarm.url = "https://example.com/mcp"; }, /only the hosted/],
    ["plugin", (plugin) => { plugin.extensions["com.openai"].apps = "./.app.json"; }, /no apps or hooks/],
    ["plugin", (plugin) => { plugin.extensions["com.openai"].hooks = "./hooks/hooks.json"; }, /no apps or hooks/],
    ["plugin", (plugin) => { plugin.extensions["com.openai"].review.test_credentials = "synthetic forbidden field"; }, /credentials and reviewer instructions/],
    ["plugin", (plugin) => { plugin.extensions["com.openai"].interface.shortDescription = "x".repeat(31); }, /shortDescription/],
    ["plugin", (plugin) => { plugin.extensions["com.openai"].review.test_cases.positive.pop(); }, /exactly 5 positive/],
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

test("OA-03/OA-09: draft builds disclose missing prerequisites and submission mode refuses them", () => {
  fixture(({ invoke }) => {
    const draft = invoke("--validate-only");
    assert.equal(draft.status, 0);
    assert.match(draft.stdout, /DRAFT ONLY: missing supportURL, demo_recording_url/);
    const submission = invoke("--validate-only", "--submission-ready");
    assert.equal(submission.status, 1);
    assert.match(submission.stderr, /submission prerequisites missing: supportURL, demo_recording_url/);
  });
});

test("OA-01/OA-04/OA-12: reproducible ZIP contains exactly the manifests, MIT license and original icon", () => {
  fixture(({ source, temporaryRoot, invoke }) => {
    const first = join(temporaryRoot, "first");
    const second = join(temporaryRoot, "second");
    const built = invoke("--output-dir", first);
    assert.equal(built.status, 0, built.stderr);
    utimesSync(join(source, "plugin.json"), new Date("2000-01-01"), new Date("2000-01-01"));
    assert.equal(invoke("--output-dir", second).status, 0);
    const zip = join(first, "commonswarm-chatgpt.zip");
    assert.deepEqual(readFileSync(zip), readFileSync(join(second, "commonswarm-chatgpt.zip")));
    const inspected = spawnSync("python3", ["-c", `
import sys, zipfile
from pathlib import Path
with zipfile.ZipFile(sys.argv[1]) as z:
    assert z.namelist() == ['LICENSE', 'assets/app-icon-512.png', 'mcp.json', 'plugin.json']
    assert z.testzip() is None
    assert z.read('assets/app-icon-512.png') == Path(sys.argv[2]).read_bytes()
    assert z.read('LICENSE') == Path(sys.argv[3]).read_bytes()
    for i in z.infolist():
        assert i.date_time == (1980, 1, 1, 0, 0, 0)
        assert i.external_attr >> 16 == 0o100644
print('PASS: complete archive inventory, CRCs, original assets and fixed metadata')
`, zip, join(root, "site/public/brand/app-icon-512.png"), join(root, "LICENSE")], { encoding: "utf8" });
    assert.equal(inspected.status, 0, inspected.stderr);
  });
});

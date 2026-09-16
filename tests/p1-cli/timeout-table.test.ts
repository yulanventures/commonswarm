import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { enumerateRepository } from "../../scripts/timeout-table/enumerate.mjs";
import { validateMapping } from "../../scripts/timeout-table/mapping.mjs";
import { markdownReport } from "../../scripts/timeout-table/run.mjs";
import { readJsonLines, runChild, summarize, withPrivateProfile } from "../../scripts/timeout-table/core.mjs";

const repo = resolve(import.meta.dirname, "../..");

async function listen(delayMs: () => number) {
  let requests = 0;
  let receivedSecret = false;
  const server = createServer(async (request, response) => {
    requests += 1;
    receivedSecret ||= request.headers.authorization === "Bearer secret-shaped-value";
    await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs()));
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"external":{}}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    get requests() { return requests; },
    get receivedSecret() { return receivedSecret; },
  };
}

test("timeout inventory and mapping are exact in both directions", async () => {
  const inventory = enumerateRepository({ repo });
  const released = enumerateRepository({ repo, ref: "v0.1.71" });
  assert.deepEqual(released.map(row => row.id), inventory.map(row => row.id));
  const mapping = JSON.parse(await readFile(join(repo, "scripts/timeout-table/mapping.json"), "utf8"));
  assert.equal(validateMapping(inventory, mapping), true);

  const missing = structuredClone(mapping);
  delete missing.rows[inventory[0]!.id];
  assert.throws(() => validateMapping(inventory, missing), /missing=/);

  const stale = structuredClone(mapping);
  stale.rows["src/not-present.ts:1:TIMEOUT_MS"] = structuredClone(mapping.rows[inventory[0]!.id]);
  assert.throws(() => validateMapping(inventory, stale), /stale=/);
});

test("delayed local endpoint makes the rendered row pass below half-budget and fail above it", async (t) => {
  let delay = 15;
  const target = await listen(() => delay);
  t.after(() => target.server.close());
  const durations: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    const response = await fetch(`${target.url}/functions/v1/read`);
    await response.arrayBuffer();
    durations.push(performance.now() - started);
  }
  assert.equal(summarize(durations, 100).gate, "PASS");

  delay = 70;
  const slow: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    const response = await fetch(`${target.url}/functions/v1/read`);
    await response.arrayBuffer();
    slow.push(performance.now() - started);
  }
  assert.equal(summarize(slow, 100).gate, "FAIL");

  const id = "fixture.ts:1:TIMEOUT_MS";
  const report = markdownReport({
    baseUrl: target.url,
    inventory: [{ id, value_ms: 100, unit_note: "milliseconds" }],
    mapping: { rows: { [id]: { class: "network-api", scope: "per-request", endpoints: ["/functions/v1/read"], operation: { name: "fixture", class: "safe-read" } } } },
    measurements: new Map([["fixture", { durations: slow, realTimeouts: 0 }]]), startup: null,
  });
  assert.match(report, /\| FAIL \|/);
});

test("preload rewrites only the origin and logs no header, body, query, or secret", async (t) => {
  const original = await listen(() => 0);
  const target = await listen(() => 5);
  t.after(() => original.server.close());
  t.after(() => target.server.close());
  const directory = await mkdtemp(join(tmpdir(), "timeout-preload-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "fetch.jsonl");
  await writeFile(log, "", { mode: 0o600 });
  const code = `fetch(${JSON.stringify(`${original.url}/functions/v1/read?token=query-secret`)},{method:'POST',headers:{authorization:'Bearer secret-shaped-value'},body:'body-secret'}).then(r=>r.arrayBuffer()).then(()=>process.exit(0),()=>process.exit(1))`;
  const result = await runChild(process.execPath, ["-e", code], { env: {
    ...process.env,
    NODE_OPTIONS: `--require=${join(repo, "scripts/timeout-table/preload.cjs")}`,
    TIMEOUT_TABLE_BASE_URL: target.url,
    TIMEOUT_TABLE_PROFILE_ORIGIN: original.url,
    TIMEOUT_TABLE_FETCH_LOG: log,
  } });
  assert.equal(result.code, 0);
  assert.equal(original.requests, 0);
  assert.equal(target.requests, 1);
  assert.equal(target.receivedSecret, true);
  const raw = await readFile(log, "utf8");
  assert.doesNotMatch(raw, /secret|token|authorization|header|body|query/i);
  assert.deepEqual((await readJsonLines(log)).map(row => ({ method: row.method, path: row.path, status: row.status })),
    [{ method: "POST", path: "/functions/v1/read", status: 200 }]);
});

test("private profile copy is removed after success and injected failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeout-profile-test-"));
  await chmod(directory, 0o700);
  const credential = join(directory, "credential.json");
  const profile = join(directory, "profile.json");
  await writeFile(credential, '{"token":"secret-shaped-value","expires_at":"2099-01-01T00:00:00Z"}', { mode: 0o600 });
  await writeFile(profile, JSON.stringify({ version: 1, url: "http://127.0.0.1:1", anon_key: "public", workspace_id: "00000000-0000-4000-8000-000000000001", principal_id: "00000000-0000-4000-8000-000000000002", credential_file: credential }), { mode: 0o600 });
  try {
    let successRoot = "";
    await withPrivateProfile(profile, async copy => {
      successRoot = copy.root;
      assert.equal((await stat(copy.root)).mode & 0o777, 0o700);
      assert.equal((await stat(copy.profilePath)).mode & 0o777, 0o600);
      assert.notEqual(copy.profile.credential_file, credential);
      assert.doesNotMatch(await readFile(copy.profile.credential_file, "utf8"), /expires_at/);
    });
    await assert.rejects(stat(successRoot), { code: "ENOENT" });

    let failureRoot = "";
    await assert.rejects(withPrivateProfile(profile, async copy => {
      failureRoot = copy.root;
      throw new Error("injected failure");
    }), /injected failure/);
    await assert.rejects(stat(failureRoot), { code: "ENOENT" });
    assert.equal(await readFile(credential, "utf8"), '{"token":"secret-shaped-value","expires_at":"2099-01-01T00:00:00Z"}');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

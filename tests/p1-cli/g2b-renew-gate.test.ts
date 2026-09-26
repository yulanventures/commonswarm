import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const helper = fileURLToPath(new URL(
  "../../deploy/release-proofs/item-g2b/g2b-renew-gate.mjs",
  import.meta.url,
));
const wrapper = fileURLToPath(new URL(
  "../../deploy/release-proofs/item-g2b/g2b-renew-gate.sh",
  import.meta.url,
));
const principalId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";

function writeSeed(): string {
  const seed = mkdtempSync(join(tmpdir(), "cswarm-g2b-input-"));
  chmodSync(seed, 0o700);
  writeFileSync(join(seed, "credential.json"), JSON.stringify({
    message: "Agent credential minted. It is bound to this task and run so the agent's work stays scoped and attributable.",
    status: "accepted",
    principal_id: principalId,
    token_id: "33333333-3333-4333-8333-333333333333",
    run_id: "44444444-4444-4444-8444-444444444444",
    agent_token: `swm_agt_${"a".repeat(43)}`,
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString(),
  }), { mode: 0o600 });
  writeFileSync(join(seed, "principal.json"), JSON.stringify({ principal_id: principalId }), { mode: 0o600 });
  writeFileSync(join(seed, "anon-key.txt"), "not-a-secret-test-key\n", { mode: 0o600 });
  return seed;
}

test("G2b renew gate statistics keep the first and every call", () => {
  const output = execFileSync(process.execPath, [helper, "--self-test"], { encoding: "utf8" });
  assert.equal(output, "SELF TEST PASS\n");
});

test("G2b renew gate refuses bad inputs before transport", () => {
  const seed = mkdtempSync(join(tmpdir(), "cswarm-g2b-invalid-"));
  try {
    chmodSync(seed, 0o700);
    writeFileSync(join(seed, "credential.json"), "{}", { mode: 0o600 });
    writeFileSync(join(seed, "principal.json"), JSON.stringify({
      principal_id: "11111111-1111-4111-8111-111111111111",
    }), { mode: 0o600 });
    writeFileSync(join(seed, "anon-key.txt"), "not-a-secret-test-key\n", { mode: 0o600 });
    const run = spawnSync("bash", [
      wrapper, process.cwd(), seed, "http://127.0.0.1:1", "22222222-2222-4222-8222-222222222222",
    ], { encoding: "utf8", timeout: 2_000 });
    assert.equal(run.status, 2);
    assert.match(run.stdout, /^input: credential\.json/);
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /ECONNREFUSED|fetch failed/);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
});

test("G2b renew gate accepts a relative seed path", () => {
  const seed = writeSeed();
  try {
    const run = spawnSync("bash", [
      wrapper, process.cwd(), basename(seed), "http://127.0.0.1:1", workspaceId,
    ], { cwd: dirname(seed), encoding: "utf8", timeout: 5_000 });
    assert.equal(run.status, 8);
    assert.equal(run.stdout,
      `G2B_PRINCIPAL_ID=${principalId}\nGATE CANNOT RUN transport_failure\n`);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
});

test("G2b renew gate rejects a missing or malformed release state before transport", () => {
  const seed = writeSeed();
  try {
    const missing = spawnSync("bash", [
      wrapper, process.cwd(), seed, "http://127.0.0.1:1", workspaceId, "--release",
    ], { encoding: "utf8", timeout: 5_000 });
    assert.equal(missing.status, 2);
    assert.equal(missing.stdout,
      "input: renew-gate-state.json must exist with mode 0600\n");
    assert.doesNotMatch(`${missing.stdout}${missing.stderr}`, /ECONNREFUSED|fetch failed/);

    writeFileSync(join(seed, "renew-gate-state.json"), "[]", { mode: 0o600 });
    const malformed = spawnSync("bash", [
      wrapper, process.cwd(), seed, "http://127.0.0.1:1", workspaceId, "--release",
    ], { encoding: "utf8", timeout: 5_000 });
    assert.equal(malformed.status, 2);
    assert.equal(malformed.stdout,
      "input: renew-gate-state.json must contain a JSON object\n");
    assert.doesNotMatch(`${malformed.stdout}${malformed.stderr}`, /ECONNREFUSED|fetch failed/);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
});

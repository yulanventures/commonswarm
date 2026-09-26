import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function writeFakeRelease(): string {
  const release = mkdtempSync(join(tmpdir(), "cswarm-g2b-release-"));
  const cloud = join(release, "dist", "cloud");
  mkdirSync(cloud, { recursive: true });
  writeFileSync(join(release, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(cloud, "agent-credential-input.js"), `
    export function parseAgentCredentialInput(raw) {
      const value = JSON.parse(raw);
      return { principalId: value.principal_id, expiresAt: Date.parse(value.expires_at) };
    }
  `);
  writeFileSync(join(cloud, "agent-profile.js"), `
    import { readFile } from "node:fs/promises";
    export async function readAgentProfile(path) {
      return JSON.parse(await readFile(path, "utf8"));
    }
    export function profileTarget(profile) {
      return { url: profile.url, anonKey: profile.anon_key };
    }
    export async function openProfileCredential() {
      return { bearer: async () => "test-bearer" };
    }
  `);
  writeFileSync(join(cloud, "agent-check.js"), `
    export async function checkAgentMessages() { return { checked: true }; }
  `);
  writeFileSync(join(cloud, "wake-lease.js"), `
    export async function sendWakeLeaseCommand(options) {
      if (options.command.kind === "claim_wake_lease") return { generation: 1 };
      if (options.command.kind === "release_wake_lease") return { released: true };
      if (options.command.kind === "renew_wake_lease" && process.env.G2B_TEST_HOSTILE === "1") {
        await options.fetcher("data:application/json,%7B%22error%22%3A%22SECRET%3Dedge-leak%21%22%7D");
        throw new Error("renew rejected");
      }
      return { ok: true };
    }
  `);
  return release;
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

test("G2b renew gate keeps the release pass for exactly 50 pairs", () => {
  const seed = writeSeed();
  const release = writeFakeRelease();
  try {
    const run = spawnSync("bash", [wrapper, release, seed, "http://127.0.0.1:1", workspaceId], {
      encoding: "utf8",
      env: { ...process.env, G2B_RENEW_GATE_ROUNDS: "50" },
      timeout: 5_000,
    });
    assert.ifError(run.error);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(run.stdout.trimEnd().split("\n").at(-1), "GATE PASS");
    const report = JSON.parse(readFileSync(join(seed, "renew-gate.json"), "utf8")) as {
      header: string;
      status: string;
      release_gate: boolean;
      rounds: number;
    };
    assert.deepEqual({
      header: report.header,
      status: report.status,
      releaseGate: report.release_gate,
      rounds: report.rounds,
    }, { header: "GATE PASS", status: "PASS", releaseGate: true, rounds: 50 });
  } finally {
    rmSync(seed, { recursive: true, force: true });
    rmSync(release, { recursive: true, force: true });
  }
});

test("G2b renew gate cannot pass as a release gate with fewer than 50 pairs", () => {
  const seed = writeSeed();
  const release = writeFakeRelease();
  try {
    const run = spawnSync("bash", [wrapper, release, seed, "http://127.0.0.1:1", workspaceId], {
      encoding: "utf8",
      env: { ...process.env, G2B_RENEW_GATE_ROUNDS: "1" },
      timeout: 5_000,
    });
    assert.ifError(run.error);
    assert.equal(run.status, 10, `${run.stdout}\n${run.stderr}`);
    assert.equal(run.stdout.trimEnd().split("\n").at(-1),
      "GATE NOT A RELEASE GATE n=1 PASS");
    assert.doesNotMatch(run.stdout, /^GATE PASS$/m);
    const report = JSON.parse(readFileSync(join(seed, "renew-gate.json"), "utf8")) as {
      header: string;
      status: string;
    };
    assert.equal(report.header, "GATE NOT A RELEASE GATE n=1 PASS");
    assert.equal(report.status, "NOT_A_RELEASE_GATE");
    assert.match(readFileSync(join(seed, "renew-gate.md"), "utf8"),
      /^# GATE NOT A RELEASE GATE n=1 PASS$/m);
  } finally {
    rmSync(seed, { recursive: true, force: true });
    rmSync(release, { recursive: true, force: true });
  }
});

test("G2b renew gate reduces a hostile edge error to a stable code", () => {
  const seed = writeSeed();
  const release = writeFakeRelease();
  try {
    const run = spawnSync("bash", [wrapper, release, seed, "http://127.0.0.1:1", workspaceId], {
      encoding: "utf8",
      env: { ...process.env, G2B_RENEW_GATE_ROUNDS: "1", G2B_TEST_HOSTILE: "1" },
      timeout: 5_000,
    });
    assert.ifError(run.error);
    assert.equal(run.status, 10, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /^RENEW 1\/1 unrecognized_error /m);
    assert.equal(run.stdout.trimEnd().split("\n").at(-1),
      "GATE NOT A RELEASE GATE n=1 FAIL-1_renew_failed");
    const combined = `${run.stdout}${run.stderr}${readFileSync(join(seed, "renew-gate.json"), "utf8")}`;
    assert.doesNotMatch(combined, /SECRET|edge-leak/);
    const report = JSON.parse(readFileSync(join(seed, "renew-gate.json"), "utf8")) as {
      renew: { calls: Array<{ code: string }> };
    };
    assert.equal(report.renew.calls[0]?.code, "unrecognized_error");
  } finally {
    rmSync(seed, { recursive: true, force: true });
    rmSync(release, { recursive: true, force: true });
  }
});

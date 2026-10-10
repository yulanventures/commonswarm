/** Round-C F4 and LANE-2-DELTA D1-D3: the X2 lock-order files reach a database only through one
 * verified binding. Every refusal happens before the connector (the only SQL path) runs, and
 * nothing calls fetch. Synthetic docker inspect results and binding files only: no Docker, no
 * database. The same applies to the CI seed source (the migrations' own min_client_version) and
 * the min_client_version classification that every run applies before its scenario. The certificate below is a public, self-signed test certificate (P-256, named
 * curve, IP:127.0.0.1); its key was discarded. X509Certificate parsing does not check validity
 * dates, so its long lifetime does not affect the test. */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";

type Binding = Readonly<Record<string, string>>;
interface LiveFacts { project: string; containers: readonly string[]; network: string; ports: readonly number[]; dataDir: string }
interface Docker {
  inspectContainer(id: string): unknown;
  inspectVolume(name: string): unknown;
  inspectNetwork(name: string): unknown;
  listByLabel(key: string, value: string): { id: string; name: string }[];
  execWithSecret(id: string, script: string, args: string[], secret: string): string;
}
interface Harness {
  BINDING_ENV: string;
  FIXTURE_BINDING_KEYS: readonly string[];
  CI_BINDING_KEYS: readonly string[];
  COMPOSE_LABEL: string;
  CLI_LABEL: string;
  LockOrderBindingRefusal: new (code: string) => Error & { code: string };
  readLiveStackFacts(): LiveFacts;
  openLockOrderTarget(options: {
    env: Record<string, string | undefined>;
    live: LiveFacts;
    docker: Docker;
    supabaseStatus?: () => unknown;
    connector: (binding: Binding, tools: { docker: Docker; tlsCaPem: string | null }) => Promise<unknown>;
  }): Promise<unknown>;
  tlsClientOptions(target: { url: string; tlsCaPem: string | null }): Record<string, unknown>;
  migrationTreeLine(git?: (args: string[]) => string): string;
  LockOrderSetupFailure: new (code: string) => Error & { code: string };
  readMigrations(): { name: string; text: string }[];
  migrationMinClientVersion(migrations: unknown): string;
  sqlLexicalContexts(text: string): Uint8Array;
  classifyMinClientVersion(row: { type: string | null; text: string | null } | undefined): MinimumCheck;
  minClientVersionDiagnostic(check: MinimumCheck): string;
}
type MinimumCheck = { ok: true; version: string } | { ok: false; code: string; observed?: string };
const harness = await import(new URL("../support/admin-principal-lock-order-harness.mjs", import.meta.url).href) as Harness;

const PROJECT = "c1b-x2-abcd1234";
const FIXTURE_ID = "a".repeat(64);
const CI_ID = "b".repeat(64);
const DATA = "/var/lib/postgresql/data";
const FIXTURE_URL = "postgresql://supabase_admin:fixture-secret@127.0.0.1:55432/postgres?sslmode=verify-full";
const TEST_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBTTCB9KADAgECAgkAjr3pSS81U4kwCgYIKoZIzj0EAwIwITEfMB0GA1UEAwwW
YzFiLXgyLWxvY2stb3JkZXItdGVzdDAgFw0yNjEwMTAxNzIwMzVaGA8yMTI2MDkx
NjE3MjAzNVowITEfMB0GA1UEAwwWYzFiLXgyLWxvY2stb3JkZXItdGVzdDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABMWHBX6dBso90cfVVQmD/gVNHGHLt+0c/ATv
h5MDfDw3p2a3DyYID3raCsAS1tXb6UiKKt79Wcp6rnmeKbJWXnmjEzARMA8GA1Ud
EQQIMAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgcBstVNAfPjMwB9Vd7YGsu3gU
Zw0TDubNlLPgcBjHM4wCIQCS/g7CGh/i7hZw7aanxv9Zd9WSo8qP7NxF+m9LTC4W
3w==
-----END CERTIFICATE-----
`;
let live: LiveFacts;
let directory: string;
let caFile: string;
const upstreamFetch = globalThis.fetch;
let fetchCalls = 0;

before(() => {
  live = harness.readLiveStackFacts();
  directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "lock-order-binding-")));
  caFile = join(directory, "fixture-ca.pem");
  writeFileSync(caFile, TEST_CERTIFICATE, { mode: 0o644 });
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("the binding validator must not make HTTP calls");
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = upstreamFetch;
  assert.equal(dirname(directory), realpathSync(tmpdir()));
  assert.ok(basename(directory).startsWith("lock-order-binding-"));
  rmSync(directory, { recursive: true });
});

function fixtureBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "fixture",
    db_container_id: FIXTURE_ID,
    db_url: FIXTURE_URL,
    db_tls_ca_file: caFile,
    compose_project: PROJECT,
    compose_network: `${PROJECT}_net`,
    compose_volume: `${PROJECT}_pgdata`,
    ...overrides,
  };
}

let fileCounter = 0;
function caCopy(content: string): string {
  const path = join(directory, `ca-${++fileCounter}.pem`);
  writeFileSync(path, content, { mode: 0o644 });
  return path;
}
function bindingFile(value: unknown, mode = 0o600): string {
  const path = join(directory, `binding-${++fileCounter}.json`);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode });
  chmodSync(path, mode);
  return path;
}

interface DockerState {
  container: Record<string, unknown>;
  volume: Record<string, unknown> | null;
  network: Record<string, unknown> | null;
  listed: { id: string; name: string }[];
}
function container(id: string, name: string, label: string, project: string, network: string, volume: string, port: string,
  overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: id,
    Name: `/${name}`,
    State: { Running: true },
    Config: { Labels: { [label]: project } },
    NetworkSettings: { Networks: { [network]: {} }, Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: port }] } },
    Mounts: [{ Type: "volume", Name: volume, Source: `/var/lib/docker/volumes/${volume}/_data`, Destination: DATA }],
    ...overrides,
  };
}
function fixtureState(overrides: Partial<DockerState> = {}): DockerState {
  return {
    container: container(FIXTURE_ID, `${PROJECT}-postgres`, harness.COMPOSE_LABEL, PROJECT, `${PROJECT}_net`, `${PROJECT}_pgdata`, "55432"),
    volume: { Name: `${PROJECT}_pgdata`, Labels: { [harness.COMPOSE_LABEL]: PROJECT } },
    network: { Name: `${PROJECT}_net`, Labels: { [harness.COMPOSE_LABEL]: PROJECT } },
    listed: [],
    ...overrides,
  };
}
function ciState(overrides: Partial<DockerState> = {}): DockerState {
  const ci = container(CI_ID, "supabase_db_cloud-swarm", harness.CLI_LABEL, "cloud-swarm", "supabase_network_cloud-swarm",
    "supabase_db_cloud-swarm", "54322");
  // The CLI publishes HostPort only (db/start/start.go:120), so Docker lists 0.0.0.0 and ::.
  (ci.NetworkSettings as Record<string, unknown>).Ports = {
    "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "54322" }, { HostIp: "::", HostPort: "54322" }],
  };
  return {
    container: ci,
    volume: { Name: "supabase_db_cloud-swarm", Labels: { [harness.CLI_LABEL]: "cloud-swarm" } },
    network: { Name: "supabase_network_cloud-swarm", Labels: { [harness.CLI_LABEL]: "cloud-swarm" } },
    listed: [{ id: CI_ID, name: "supabase_db_cloud-swarm" }, { id: "c".repeat(64), name: "supabase_kong_cloud-swarm" }],
    ...overrides,
  };
}
function docker(state: DockerState): Docker {
  return {
    inspectContainer: (id) => (state.container.Id === id ? state.container : null),
    inspectVolume: (name) => (state.volume?.Name === name ? state.volume : null),
    inspectNetwork: (name) => (state.network?.Name === name ? state.network : null),
    listByLabel: (key, value) => (key === harness.CLI_LABEL && value === "cloud-swarm" ? state.listed : []),
    execWithSecret: () => { throw new Error("no command runs inside a container before the connector"); },
  };
}

interface Attempt { connector: number; status: number; binding: Binding | null; tlsCaPem: string | null | undefined; outcome: unknown }
async function attempt(env: Record<string, string | undefined>, state: DockerState,
  status: Record<string, string> = { DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" }): Promise<Attempt> {
  const record: Attempt = { connector: 0, status: 0, binding: null, tlsCaPem: undefined, outcome: null };
  try {
    await harness.openLockOrderTarget({
      env, live, docker: docker(state),
      supabaseStatus: () => { record.status += 1; return status; },
      connector: async (binding, tools) => {
        record.connector += 1;
        record.binding = binding;
        record.tlsCaPem = tools.tlsCaPem;
        return "connected";
      },
    });
    record.outcome = "admitted";
  } catch (error) {
    record.outcome = error;
  }
  return record;
}
function assertRefused(record: Attempt, code: string): void {
  assert.ok(record.outcome instanceof harness.LockOrderBindingRefusal, `expected refusal ${code}, got ${String(record.outcome)}`);
  assert.equal((record.outcome as { code: string }).code, code);
  assert.equal(record.connector, 0, "a refused target never reaches the connector (zero SQL)");
  assert.equal(fetchCalls, 0, "a refused target makes zero HTTP calls");
}
const fixtureEnv = (path: string, extra: Record<string, string> = {}) => ({ [harness.BINDING_ENV]: path, ...extra });

test("live staging facts are read from the reviewed compose files", () => {
  assert.equal(live.project, "commonswarm-supabase-stack");
  assert.deepEqual([...live.containers].sort(), [
    "commonswarm-gotrue", "commonswarm-postgres", "commonswarm-postgrest", "commonswarm-realtime", "commonswarm-storage-api",
  ]);
  assert.equal(live.network, "commonswarm-net");
  assert.deepEqual(live.ports, [9000, 18001, 18002, 18003, 18004]);
  assert.equal(live.dataDir, "/var/lib/commonswarm/postgres");
  assert.deepEqual(harness.FIXTURE_BINDING_KEYS,
    ["compose_network", "compose_project", "compose_volume", "db_container_id", "db_tls_ca_file", "db_url", "mode"]);
  assert.deepEqual(harness.CI_BINDING_KEYS, ["compose_network", "compose_project", "compose_volume", "db_container_id", "db_url", "mode"]);
});

test("positive control: a verified fixture binding is admitted once, unchanged, with its CA", async () => {
  const value = fixtureBinding();
  const record = await attempt(fixtureEnv(bindingFile(value), { GITHUB_ACTIONS: "true" }), fixtureState());
  assert.equal(record.outcome, "admitted");
  assert.equal(record.connector, 1);
  assert.equal(record.status, 0, "a binding file wins over the CI derivation");
  assert.deepEqual({ ...record.binding }, value);
  assert.equal(record.tlsCaPem, TEST_CERTIFICATE, "the connector receives the verified CA");
  assert.equal(fetchCalls, 0);
});

test("positive control: an exposed but unpublished port is not a published binding", async () => {
  const state = fixtureState();
  (state.container.NetworkSettings as Record<string, unknown>).Ports = {
    "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }], "8008/tcp": null,
  };
  const record = await attempt(fixtureEnv(bindingFile(fixtureBinding())), state);
  assert.equal(record.outcome, "admitted");
  assert.equal(record.connector, 1);
});

test("positive control: under GitHub Actions with no binding file, the CLI project binding is admitted", async () => {
  const record = await attempt({ GITHUB_ACTIONS: "true" }, ciState());
  assert.equal(record.outcome, "admitted");
  assert.equal(record.connector, 1);
  assert.equal(record.status, 1);
  assert.equal(record.tlsCaPem, null, "the CI stack has no fixture CA");
  assert.deepEqual({ ...record.binding }, {
    mode: "ci",
    db_container_id: CI_ID,
    db_url: "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres",
    compose_project: "cloud-swarm",
    compose_network: "supabase_network_cloud-swarm",
    compose_volume: "supabase_db_cloud-swarm",
  });
  assert.equal(fetchCalls, 0);
});

test("an unset binding refuses outside GitHub Actions", async () => {
  assertRefused(await attempt({}, ciState()), "binding_required");
  assertRefused(await attempt({ GITHUB_ACTIONS: "false" }, ciState()), "binding_required");
});

test("binding file refusals", async (t) => {
  await t.test("relative path", async () => {
    assertRefused(await attempt(fixtureEnv("binding.json"), fixtureState()), "binding_path_not_absolute");
  });
  await t.test("missing file", async () => {
    assertRefused(await attempt(fixtureEnv(join(directory, "absent.json")), fixtureState()), "binding_file_missing");
  });
  await t.test("symlink", async () => {
    const link = join(directory, "link.json");
    symlinkSync(bindingFile(fixtureBinding()), link);
    assertRefused(await attempt(fixtureEnv(link), fixtureState()), "binding_file_symlink");
  });
  await t.test("not 0600", async () => {
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding(), 0o644)), fixtureState()), "binding_file_mode");
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding(), 0o400)), fixtureState()), "binding_file_mode");
  });
  await t.test("not JSON", async () => {
    assertRefused(await attempt(fixtureEnv(bindingFile("{not json")), fixtureState()), "binding_file_invalid");
  });
  await t.test("extra key", async () => {
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ api_url: "http://127.0.0.1:55421" }))), fixtureState()), "binding_keys");
  });
  await t.test("missing key", async () => {
    const value = fixtureBinding();
    delete value.compose_volume;
    assertRefused(await attempt(fixtureEnv(bindingFile(value)), fixtureState()), "binding_keys");
  });
  await t.test("wrong mode", async () => {
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ mode: "ci" }))), fixtureState()), "binding_mode");
  });
  await t.test("container id not 64 hex", async () => {
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ db_container_id: "abc123" }))), fixtureState()), "container_id_format");
  });
});

test("live-target refusals", async (t) => {
  await t.test("the live compose project", async () => {
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ compose_project: live.project }))), fixtureState()), "live_compose_project");
  });
  await t.test("a project outside c1b-x2-<8>", async () => {
    for (const project of ["c1b-x2-ABCD1234", "c1b-x2-abcd123", "staging", "c1b-x2-abcd1234-extra"]) {
      assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ compose_project: project }))), fixtureState()), "compose_project_not_allowed");
    }
  });
  await t.test("the live network", async () => {
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ compose_network: live.network }))), fixtureState()), "live_network");
    const state = fixtureState();
    (state.container.NetworkSettings as Record<string, unknown>).Networks = { [live.network]: {} };
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding())), state), "live_network");
  });
  await t.test("every live container name", async () => {
    for (const name of live.containers) {
      const state = fixtureState();
      state.container.Name = `/${name}`;
      assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding())), state), "live_container_name");
    }
  });
  await t.test("every live published port", async () => {
    for (const port of live.ports) {
      const value = fixtureBinding({ db_url: `postgresql://supabase_admin:fixture-secret@127.0.0.1:${port}/postgres?sslmode=verify-full` });
      assertRefused(await attempt(fixtureEnv(bindingFile(value)), fixtureState()), "live_published_port");
    }
  });
  await t.test("a non-loopback endpoint", async () => {
    for (const host of ["10.0.0.5", "db.example.test", "0.0.0.0", "178.105.29.28"]) {
      const value = fixtureBinding({ db_url: `postgresql://supabase_admin:fixture-secret@${host}:55432/postgres?sslmode=verify-full` });
      assertRefused(await attempt(fixtureEnv(bindingFile(value)), fixtureState()), "endpoint_not_loopback");
    }
  });
  await t.test("a host bind mount of the live data directory", async () => {
    const state = fixtureState();
    state.container.Mounts = [
      { Type: "bind", Source: live.dataDir, Destination: DATA },
    ];
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding())), state), "live_data_bind_mount");
    const nested = fixtureState();
    (nested.container.Mounts as unknown[]).push({ Type: "bind", Source: `${live.dataDir}/pg_wal`, Destination: "/wal" });
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding())), nested), "live_data_bind_mount");
  });
  await t.test("a live compose label on the container", async () => {
    const state = fixtureState();
    state.container.Config = { Labels: { [harness.COMPOSE_LABEL]: live.project } };
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding())), state), "live_compose_project");
  });
});

test("label, network, mount and port mismatches refuse", async (t) => {
  const path = () => fixtureEnv(bindingFile(fixtureBinding()));
  await t.test("container id differs", async () => {
    assertRefused(await attempt(path(), fixtureState({ container: { ...fixtureState().container, Id: "d".repeat(64) } })), "container_id_mismatch");
  });
  await t.test("container not running", async () => {
    assertRefused(await attempt(path(), fixtureState({ container: { ...fixtureState().container, State: { Running: false } } })), "container_not_running");
  });
  await t.test("container label", async () => {
    const state = fixtureState();
    state.container.Config = { Labels: { [harness.COMPOSE_LABEL]: "c1b-x2-zzzz9999" } };
    assertRefused(await attempt(path(), state), "container_label_mismatch");
  });
  await t.test("container network set", async () => {
    const extra = fixtureState();
    (extra.container.NetworkSettings as Record<string, unknown>).Networks = { [`${PROJECT}_net`]: {}, bridge: {} };
    assertRefused(await attempt(path(), extra), "container_network_mismatch");
    const other = fixtureState();
    (other.container.NetworkSettings as Record<string, unknown>).Networks = { bridge: {} };
    assertRefused(await attempt(path(), other), "container_network_mismatch");
  });
  await t.test("data mount", async () => {
    const named = fixtureState();
    named.container.Mounts = [{ Type: "volume", Name: "other_pgdata", Destination: DATA }];
    assertRefused(await attempt(path(), named), "data_volume_mismatch");
    const anonymous = fixtureState();
    anonymous.container.Mounts = [];
    assertRefused(await attempt(path(), anonymous), "data_volume_mismatch");
    const bind = fixtureState();
    bind.container.Mounts = [{ Type: "bind", Source: "/srv/other", Destination: DATA }];
    assertRefused(await attempt(path(), bind), "data_volume_mismatch");
  });
  await t.test("volume label", async () => {
    assertRefused(await attempt(path(), fixtureState({ volume: { Name: `${PROJECT}_pgdata`, Labels: {} } })), "volume_label_mismatch");
    assertRefused(await attempt(path(), fixtureState({ volume: null })), "volume_label_mismatch");
  });
  await t.test("network label (D2)", async () => {
    assertRefused(await attempt(path(), fixtureState({ network: { Name: `${PROJECT}_net`, Labels: { [harness.COMPOSE_LABEL]: "c1b-x2-zzzz9999" } } })), "network_label_mismatch");
    assertRefused(await attempt(path(), fixtureState({ network: { Name: `${PROJECT}_net`, Labels: {} } })), "network_label_mismatch");
    assertRefused(await attempt(path(), fixtureState({ network: { Name: `${PROJECT}_net`, Labels: { [harness.CLI_LABEL]: PROJECT } } })), "network_label_mismatch");
    assertRefused(await attempt(path(), fixtureState({ network: null })), "network_label_mismatch");
  });
  await t.test("published port", async () => {
    const state = fixtureState();
    (state.container.NetworkSettings as Record<string, unknown>).Ports = { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55433" }] };
    assertRefused(await attempt(path(), state), "published_port_mismatch");
    const unpublished = fixtureState();
    (unpublished.container.NetworkSettings as Record<string, unknown>).Ports = {};
    assertRefused(await attempt(path(), unpublished), "published_port_mismatch");
  });
});

test("fixture transport refusals (D1)", async (t) => {
  await t.test("no db_tls_ca_file", async () => {
    const value = fixtureBinding();
    delete value.db_tls_ca_file;
    assertRefused(await attempt(fixtureEnv(bindingFile(value)), fixtureState()), "binding_keys");
  });
  await t.test("an API endpoint in a fixture binding", async () => {
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ api_url: "http://127.0.0.1:55421" }))), fixtureState()), "binding_keys");
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ api_container_id: "c".repeat(64) }))), fixtureState()), "binding_keys");
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({
      api_url: "http://127.0.0.1:55421", api_container_id: "c".repeat(64) }))), fixtureState()), "binding_keys");
  });
  await t.test("a symlinked CA file", async () => {
    const link = join(directory, `ca-link-${++fileCounter}.pem`);
    symlinkSync(caFile, link);
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ db_tls_ca_file: link }))), fixtureState()), "tls_ca_file_symlink");
  });
  await t.test("a CA path that is relative, missing or a directory", async () => {
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ db_tls_ca_file: "fixture-ca.pem" }))), fixtureState()), "tls_ca_path_not_absolute");
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ db_tls_ca_file: join(directory, "absent.pem") }))), fixtureState()), "tls_ca_file_missing");
    const folder = join(directory, `ca-dir-${++fileCounter}`);
    mkdirSync(folder);
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ db_tls_ca_file: folder }))), fixtureState()), "tls_ca_file_not_regular");
  });
  await t.test("a CA file that is not exactly one PEM certificate", async () => {
    const body = TEST_CERTIFICATE.split("\n").slice(1, -2).join("\n");
    for (const content of [
      "not a certificate\n",
      "",
      `${TEST_CERTIFICATE}${TEST_CERTIFICATE}`,
      `${TEST_CERTIFICATE}-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n`,
      `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`,
      "-----BEGIN CERTIFICATE-----\nAAAAAAAA\n-----END CERTIFICATE-----\n",
    ]) {
      assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding({ db_tls_ca_file: caCopy(content) }))), fixtureState()),
        "tls_ca_not_one_pem_certificate");
    }
  });
  await t.test("a fixture db_url without sslmode=verify-full", async () => {
    for (const suffix of ["", "?sslmode=require", "?sslmode=verify-ca", "?sslmode=disable", "?sslmode=verify-full&options=-c%20lock_timeout%3D0",
      "?sslrootcert=system", "?sslmode=verify-full&sslmode=verify-full"]) {
      const value = fixtureBinding({ db_url: `postgresql://supabase_admin:fixture-secret@127.0.0.1:55432/postgres${suffix}` });
      assertRefused(await attempt(fixtureEnv(bindingFile(value)), fixtureState()), "db_url_tls_not_verify_full");
    }
  });
  await t.test("a fixture endpoint other than 127.0.0.1", async () => {
    for (const host of ["localhost", "[::1]"]) {
      const value = fixtureBinding({ db_url: `postgresql://supabase_admin:fixture-secret@${host}:55432/postgres?sslmode=verify-full` });
      assertRefused(await attempt(fixtureEnv(bindingFile(value)), fixtureState()), "fixture_endpoint_not_127_0_0_1");
    }
  });
  await t.test("a second published port or binding", async () => {
    const second = fixtureState();
    (second.container.NetworkSettings as Record<string, unknown>).Ports = {
      "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }], "8008/tcp": [{ HostIp: "127.0.0.1", HostPort: "55433" }],
    };
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding())), second), "published_binding_extra");
    const twice = fixtureState();
    (twice.container.NetworkSettings as Record<string, unknown>).Ports = {
      "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }, { HostIp: "127.0.0.1", HostPort: "55434" }],
    };
    assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding())), twice), "published_binding_extra");
  });
  await t.test("a published host IP other than 127.0.0.1", async () => {
    for (const ports of [
      { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "55432" }] },
      { "5432/tcp": [{ HostIp: "", HostPort: "55432" }] },
      { "5432/tcp": [{ HostIp: "::1", HostPort: "55432" }] },
      { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }, { HostIp: "::", HostPort: "55432" }] },
      { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }], "8008/tcp": [{ HostIp: "0.0.0.0", HostPort: "8008" }] },
    ]) {
      const state = fixtureState();
      (state.container.NetworkSettings as Record<string, unknown>).Ports = ports;
      assertRefused(await attempt(fixtureEnv(bindingFile(fixtureBinding())), state), "published_host_not_127_0_0_1");
    }
  });
});

test("test-side TLS options verify the dialed fixture address", () => {
  assert.deepEqual(harness.tlsClientOptions({ url: "postgresql://u:p@127.0.0.1:54322/postgres", tlsCaPem: null }), {});
  assert.deepEqual(harness.tlsClientOptions({ url: FIXTURE_URL, tlsCaPem: TEST_CERTIFICATE }),
    { ssl: { ca: TEST_CERTIFICATE, rejectUnauthorized: true, host: "127.0.0.1" } });
});

test("D3: the migration tree line", () => {
  const head = "0123456789abcdef0123456789abcdef01234567", tree = "89abcdef0123456789abcdef0123456789abcdef";
  const git = (answers: Record<string, string>) => (args: string[]) => {
    const answer = answers[args.join(" ")];
    if (answer === undefined) throw new Error("git failed");
    return answer;
  };
  assert.equal(harness.migrationTreeLine(git({ "rev-parse HEAD": head, "rev-parse HEAD:supabase/migrations": tree })),
    `C1B_LOCK_ORDER_TREE head=${head} migrations=${tree}`);
  assert.equal(harness.migrationTreeLine(git({ "rev-parse HEAD": head })), "C1B_LOCK_ORDER_TREE unavailable");
  assert.equal(harness.migrationTreeLine(git({})), "C1B_LOCK_ORDER_TREE unavailable");
  assert.equal(harness.migrationTreeLine(git({ "rev-parse HEAD": head.toUpperCase(), "rev-parse HEAD:supabase/migrations": tree })),
    "C1B_LOCK_ORDER_TREE unavailable");
  assert.equal(harness.migrationTreeLine(git({ "rev-parse HEAD": `${head}0`, "rev-parse HEAD:supabase/migrations": tree })),
    "C1B_LOCK_ORDER_TREE unavailable");
  // Positive control: the real checkout under test.
  assert.match(harness.migrationTreeLine(), /^C1B_LOCK_ORDER_TREE (?:head=[0-9a-f]{40} migrations=[0-9a-f]{40}|unavailable)$/u);
});

test("CI derivation refusals", async (t) => {
  await t.test("no unique CLI database container", async () => {
    assertRefused(await attempt({ GITHUB_ACTIONS: "true" }, ciState({ listed: [] })), "ci_database_container_not_unique");
    assertRefused(await attempt({ GITHUB_ACTIONS: "true" }, ciState({ listed: [
      { id: CI_ID, name: "supabase_db_cloud-swarm" }, { id: "e".repeat(64), name: "supabase_db_cloud-swarm" },
    ] })), "ci_database_container_not_unique");
  });
  await t.test("a non-loopback status URL", async () => {
    assertRefused(await attempt({ GITHUB_ACTIONS: "true" }, ciState(),
      { DB_URL: "postgresql://postgres:postgres@10.1.2.3:54322/postgres" }), "endpoint_not_loopback");
  });
  await t.test("an unreadable status", async () => {
    assertRefused(await attempt({ GITHUB_ACTIONS: "true" }, ciState(), { API_URL: "http://127.0.0.1:54321" }), "ci_status_invalid");
  });
  await t.test("a container without the CLI project label", async () => {
    const state = ciState();
    state.container.Config = { Labels: { [harness.COMPOSE_LABEL]: "cloud-swarm" } };
    assertRefused(await attempt({ GITHUB_ACTIONS: "true" }, state), "container_label_mismatch");
  });
  await t.test("a volume or network outside the CLI project", async () => {
    assertRefused(await attempt({ GITHUB_ACTIONS: "true" }, ciState({ volume: { Name: "supabase_db_cloud-swarm", Labels: { [harness.CLI_LABEL]: "other" } } })), "volume_label_mismatch");
    assertRefused(await attempt({ GITHUB_ACTIONS: "true" }, ciState({ network: { Name: "supabase_network_cloud-swarm", Labels: {} } })), "network_label_mismatch");
  });
  await t.test("the published port differs from the status URL", async () => {
    assertRefused(await attempt({ GITHUB_ACTIONS: "true" }, ciState(),
      { DB_URL: "postgresql://postgres:postgres@127.0.0.1:54399/postgres" }), "published_port_mismatch");
  });
});

test("the binding file never reaches output: refusals carry codes, not values", async () => {
  const secret = "fixture-secret-value-0001";
  const record = await attempt(fixtureEnv(bindingFile(fixtureBinding({
    db_url: `postgresql://supabase_admin:${secret}@127.0.0.1:18002/postgres?sslmode=verify-full`,
  }))), fixtureState());
  assertRefused(record, "live_published_port");
  assert.equal(String((record.outcome as Error).message).includes(secret), false);
  assert.equal(readFileSync(join(directory, `binding-${fileCounter}.json`), "utf8").includes(secret), true, "control: the secret was in the file");
});

test("min_client_version classification: missing, non-string, non-semver and valid", () => {
  const check = (row: { type: string | null; text: string | null } | undefined) => harness.classifyMinClientVersion(row);
  const diagnostic = (row: { type: string | null; text: string | null } | undefined) => harness.minClientVersionDiagnostic(check(row));
  assert.deepEqual(check(undefined), { ok: false, code: "min_client_version_missing" });
  for (const [type, text] of [["number", "1"], ["null", null], ["object", "{\"v\": \"0.1.0\"}"], ["array", "[\"0.1.0\"]"], ["boolean", "true"]]) {
    assert.deepEqual(check({ type, text }), { ok: false, code: "min_client_version_non_string" }, `${type} is not a string`);
    assert.equal(diagnostic({ type, text }), "min_client_version_non_string", `${type}: no value is echoed`);
  }
  // Round 2's seed defect: the string held its own JSON quotes. It is classified, never echoed.
  assert.deepEqual(check({ type: "string", text: "\"0.1.0\"" }), { ok: false, code: "min_client_version_non_semver" });
  assert.equal(diagnostic({ type: "string", text: "\"0.1.0\"" }), "min_client_version_non_semver");
  for (const value of ["0.1", "0.1.0-rc.1", "v0.1.0", "0.1.0+build.7", "-"]) {
    assert.deepEqual(check({ type: "string", text: value }), { ok: false, code: "min_client_version_non_semver", observed: value });
    assert.equal(diagnostic({ type: "string", text: value }), `min_client_version_non_semver:observed=${value}`);
  }
  for (const value of ["", " 0.1.0", "0.1.0 secret", "0.1.0\n", "postgres://user:pw@h/db", "9".repeat(33)]) {
    assert.deepEqual(check({ type: "string", text: value }), { ok: false, code: "min_client_version_non_semver" }, "only a short plain value is echoed");
    assert.equal(diagnostic({ type: "string", text: value }), "min_client_version_non_semver");
  }
  // Positive controls.
  assert.deepEqual(check({ type: "string", text: "0.1.0" }), { ok: true, version: "0.1.0" });
  assert.deepEqual(check({ type: "string", text: "12.34.567" }), { ok: true, version: "12.34.567" });
});

test("the CI seed takes min_client_version from the migrations' own default", () => {
  const refusedWith = (code: string) => (error: unknown) =>
    error instanceof harness.LockOrderSetupFailure && error.code === code;
  // Positive control: the real migrations of this checkout.
  // supabase/migrations/20260723000001_p1_schema.sql:441 seeds ('min_client_version', '"0.1.0"'::jsonb).
  const migrations = harness.readMigrations();
  assert.ok(migrations.some((file) => file.name === "20260723000001_p1_schema.sql"));
  assert.equal(harness.migrationMinClientVersion(migrations), "0.1.0");
  const seed = (row = "('min_client_version', '\"0.1.0\"'::jsonb)", conflict = "DO NOTHING") =>
    `INSERT INTO swarm.config (key, value)\nVALUES\n  ${row},\n  ('idempotency_retention_days', '30'::jsonb)\nON CONFLICT (key) ${conflict};\n`;
  const file = (text: string, name = "20260101000001_seed.sql") => ({ name, text });
  // Positive control: the synthetic form the refusals below change one part of.
  assert.equal(harness.migrationMinClientVersion([file(seed())]), "0.1.0");
  assert.equal(harness.migrationMinClientVersion([file(seed("('min_client_version', '\"2.10.3\"'::jsonb)"))]), "2.10.3");
  assert.throws(() => harness.migrationMinClientVersion([]), refusedWith("seed_migrations_unreadable"));
  assert.throws(() => harness.migrationMinClientVersion([file("SELECT 1;\n")]), refusedWith("seed_min_client_version_not_unique"));
  assert.throws(() => harness.migrationMinClientVersion([file(seed()), file(
    "UPDATE swarm.config SET value = '\"0.2.0\"'::jsonb WHERE key = 'min_client_version';\n", "20260101000002_bump.sql")]),
  refusedWith("seed_min_client_version_not_unique"), "a later override refuses");
  assert.throws(() => harness.migrationMinClientVersion([file(`${seed()}-- min_client_version is public\n`)]),
    refusedWith("seed_min_client_version_not_unique"));
  assert.throws(() => harness.migrationMinClientVersion([file(seed("('min_client_version', '1'::jsonb)"))]),
    refusedWith("seed_min_client_version_row_unparsed"), "a non-string default");
  assert.throws(() => harness.migrationMinClientVersion([file(seed("('min_client_version', '\"0.1\"'::jsonb)"))]),
    refusedWith("seed_min_client_version_non_semver"));
  assert.throws(() => harness.migrationMinClientVersion([file(seed(undefined, "DO UPDATE SET value = EXCLUDED.value"))]),
    refusedWith("seed_min_client_version_statement_unparsed"), "an upsert is not the default seed");
  assert.throws(() => harness.migrationMinClientVersion([file(seed().replace("swarm.config", "swarm.other_config"))]),
    refusedWith("seed_min_client_version_statement_unparsed"), "another table");
  // Review A F3: only a statement that runs counts. The real migrations above are the executable
  // positive control; the same seed inside a comment refuses.
  assert.throws(() => harness.migrationMinClientVersion([file(`/*\n${seed()}*/\n`)]),
    refusedWith("seed_min_client_version_not_executable"), "a block-commented seed");
  assert.throws(() => harness.migrationMinClientVersion([file(seed().replace(/^/gmu, "-- "))]),
    refusedWith("seed_min_client_version_not_executable"), "a line-commented seed");
  assert.throws(() => harness.migrationMinClientVersion([file(`/* outer /* inner */\n${seed()}*/\n`)]),
    refusedWith("seed_min_client_version_not_executable"), "block comments nest, as in PostgreSQL");
  assert.throws(() => harness.migrationMinClientVersion([file(`DO $seed$\nBEGIN\n${seed()}END\n$seed$;\n`)]),
    refusedWith("seed_min_client_version_not_executable"), "a seed inside a dollar-quoted body");
  assert.throws(() => harness.migrationMinClientVersion([file(`PREPARE seed AS\n${seed()}`)]),
    refusedWith("seed_min_client_version_not_executable"), "a seed that is not its own top-level statement");
  // Positive control: comments around the statement, and comment markers inside a literal, are allowed.
  assert.equal(harness.migrationMinClientVersion([file("-- header\n/* block /* nested */ still */\n" +
    "INSERT INTO swarm.config (key, value)\nVALUES\n  ('min_client_version', '\"0.1.0\"'::jsonb),\n" +
    "  ('note', '\"-- /* not a comment\"'::jsonb)\nON CONFLICT (key) DO NOTHING; -- trailing\n")]), "0.1.0");
  // The lexer: an E'' escape and a $$ body do not end early; a -- inside them is not a comment.
  const sample = "SELECT E'a\\'-- b', $x$ -- c $x$; -- d";
  const contexts = harness.sqlLexicalContexts(sample);
  assert.deepEqual(["SELECT", "-- b", "-- c", "-- d"].map((part) => contexts[sample.indexOf(part)]), [0, 2, 2, 1]);
});

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeExactPut, prepareExactPut, RequestIdConflict } from "../../src/cloud/exact-file-put.js";
import { FileCommandRefused } from "../../src/cloud/files.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const target = { url: "http://127.0.0.1:54321", anonKey: "public-test-key", profileId: "local-test" };
const bytes = Buffer.from("# plan\n");

class FakeEdge {
  creates = 0; puts = 0; commits = 0; live = 0;
  loss: "create" | "put" | "commit" | null = null;
  putRefusal: { status: number; body: object } | null = null;
  precondition: number | null = null;
  commitRefusal: { status: number; code: string } | null = null;
  private created = new Map<string, any>();
  private committed = new Map<string, any>();
  private stored = new Set<string>();
  get uniqueCreates() { return this.created.size; }
  fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      this.puts++;
      if (this.putRefusal) return Response.json(this.putRefusal.body, { status: this.putRefusal.status });
      if (this.stored.has(url)) return Response.json({ error: "Duplicate", message: "The resource already exists" }, { status: 409 });
      this.stored.add(url);
      if (this.loss === "put") { this.loss = null; throw new Error("response lost after put"); }
      return Response.json({ Key: url });
    }
    const envelope = JSON.parse(String(init?.body));
    const cmd = envelope.command;
    if (cmd.kind === "file_version_create") {
      this.creates++;
      if (this.precondition !== null && cmd.if_version !== this.precondition) return Response.json({ error: "file_version_precondition_failed" }, { status: 409 });
      let result = this.created.get(envelope.command_id);
      if (!result) {
        const version = this.created.size + 1;
        result = { file_id: cmd.file_id, version_id: cmd.version_id, version_n: version, name: cmd.name,
          upload_path: `/storage/v1/object/upload/sign/swarm-files/${WS}/${cmd.file_id}/${version}?token=fake`, upload_token: "never-exposed", upload_expires_in_seconds: 7200 };
        this.created.set(envelope.command_id, result);
      }
      if (this.loss === "create") { this.loss = null; throw new Error("response lost after create"); }
      return Response.json(result);
    }
    if (cmd.kind === "file_version_commit") {
      this.commits++;
      if (this.commitRefusal) {
        const refusal = this.commitRefusal;
        if (refusal.code === "file_version_precondition_failed") this.stored.clear(); // Model the server's purge and Storage drain.
        return Response.json({ error: refusal.code }, { status: refusal.status });
      }
      let result = this.committed.get(envelope.command_id);
      if (!result) {
        const created = [...this.created.values()].find(row => row.version_id === cmd.version_id);
        assert.ok(created);
        if (!this.stored.has(`${target.url}${created.upload_path}`)) return Response.json({ error: "file_bytes_missing", message: "no object was uploaded for this version" }, { status: 409 });
        result = { file_id: created.file_id, version_id: created.version_id, version_n: created.version_n,
          name: created.name, size_bytes: bytes.length, sha256: cmd.sha256,
          sha256_note: "unverified client attestation", reference: `file:${created.file_id}@v${created.version_n}` };
        this.committed.set(envelope.command_id, result);
        this.live++;
      }
      if (this.loss === "commit") { this.loss = null; throw new Error("response lost after commit"); }
      return Response.json(result);
    }
    throw new Error(`unexpected command ${cmd.kind}`);
  }) as typeof fetch;
  seedCreatedObject() {
    const created = [...this.created.values()].at(-1);
    assert.ok(created);
    this.stored.add(`${target.url}${created.upload_path}`);
  }
}

function input(stateDir: string, edge: FakeEdge, overrides: Record<string, unknown> = {}) {
  return { target, workspaceId: WS, principalId: PRINCIPAL, credential: "test-credential", stateDir,
    requestId: "request01", name: "plan.md", bytes, fetcher: edge.fetcher, ...overrides };
}

for (const lost of ["create", "put", "commit"] as const) {
  test(`lost ${lost} answer resumes one version`, { timeout: 10000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
    const edge = new FakeEdge(); edge.loss = lost;
    try {
      const first = await executeExactPut(await prepareExactPut(input(dir, edge)));
      assert.ok(["committed", "replayed"].includes(first.outcome));
      const second = await executeExactPut(await prepareExactPut(input(dir, edge)));
      assert.equal(second.outcome, "replayed");
      assert.equal(edge.live, 1);
      assert.equal(edge.creates >= 1, true);
      assert.equal(edge.puts >= 1, true);
      assert.equal(edge.commits >= 1, true);
      const file = join(dir, (await readdir(dir))[0]!);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
      assert.doesNotMatch(await readFile(file, "utf8"), /test-credential|never-exposed/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("resume across a new client instance, conflict, and deleted record", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  try {
    const original = await prepareExactPut(input(dir, edge));
    const persisted = JSON.parse(await readFile(original.path, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.request_id, "request01", "intent is durable before network");
    assert.equal(persisted.phase, "prepared");
    await executeExactPut(original);
    const afterRestart = await prepareExactPut(input(dir, edge));
    assert.equal((await executeExactPut(afterRestart)).outcome, "replayed");
    const calls = edge.creates;
    await assert.rejects(prepareExactPut(input(dir, edge, { bytes: Buffer.from("different") })), RequestIdConflict);
    assert.equal(edge.creates, calls, "conflict refused before network");
    await unlink(original.path);
    edge.putRefusal = { status: 400, body: { statusCode: "409", error: "Duplicate", message: "The resource already exists" } };
    const noRecord = await executeExactPut(await prepareExactPut(input(dir, edge)));
    assert.equal(noRecord.outcome, "committed", "without a record or server replay marker, commit history is unknown");
    assert.equal(noRecord.conflict_check, "unavailable");
    assert.equal(edge.live, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("if_version and name case use the server's conflict semantics", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  try {
    const first = await prepareExactPut(input(dir, edge, { name: "PLAN.md", ifVersion: 2 }));
    const same = await prepareExactPut(input(dir, edge, { name: "plan.md", ifVersion: 2 }));
    assert.equal(same.record.version_id, first.record.version_id);
    await assert.rejects(prepareExactPut(input(dir, edge, { name: "plan.md", ifVersion: 3 })), RequestIdConflict);
    assert.equal(edge.creates, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("workspace and principal both namespace derived ids and record keys", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  try {
    const base = await prepareExactPut(input(dir, edge));
    const otherWorkspace = await prepareExactPut(input(dir, edge, { workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }));
    const otherPrincipal = await prepareExactPut(input(dir, edge, { principalId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }));
    assert.equal(new Set([base.path, otherWorkspace.path, otherPrincipal.path]).size, 3);
    assert.equal(new Set([base.record.version_id, otherWorkspace.record.version_id, otherPrincipal.record.version_id]).size, 3);
    assert.equal(new Set([base.record.create_command_id, otherWorkspace.record.create_command_id, otherPrincipal.record.create_command_id]).size, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("created phase is durable before PUT, and resume phases never regress", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  try {
    const first = await prepareExactPut(input(dir, edge, { onPhasePersisted: (value: string) => {
      if (value === "created") throw new Error("process stopped after create");
    } }));
    await assert.rejects(executeExactPut(first), /process stopped after create/);
    assert.equal(JSON.parse(await readFile(first.path, "utf8")).phase, "created");
    const seen: string[] = [];
    const second = await prepareExactPut(input(dir, edge, { onPhasePersisted: (value: string) => { seen.push(value); } }));
    await executeExactPut(second);
    assert.deepEqual(seen, ["created", "putting", "uploaded", "committed"]);
    const third = await prepareExactPut(input(dir, edge));
    assert.equal((await executeExactPut(third)).outcome, "replayed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("terminal commit refusal replays without any network or PUT", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  edge.commitRefusal = { status: 409, code: "file_version_precondition_failed" };
  try {
    const first = await prepareExactPut(input(dir, edge, { ifVersion: 2 }));
    await assert.rejects(executeExactPut(first), (error: unknown) => error instanceof FileCommandRefused && error.code === "file_version_precondition_failed");
    assert.equal(JSON.parse(await readFile(first.path, "utf8")).phase, "refused");
    const counts = [edge.creates, edge.puts, edge.commits];
    const retry = await prepareExactPut(input(dir, edge, { ifVersion: 2 }));
    await assert.rejects(executeExactPut(retry), (error: unknown) => error instanceof FileCommandRefused && error.code === "file_version_precondition_failed");
    assert.deepEqual([edge.creates, edge.puts, edge.commits], counts);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("commit rate limit remains retryable with the same request id", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  edge.commitRefusal = { status: 429, code: "rate_limited" };
  try {
    const first = await prepareExactPut(input(dir, edge));
    await assert.rejects(executeExactPut(first), (error: unknown) => error instanceof FileCommandRefused && error.status === 429);
    assert.equal(JSON.parse(await readFile(first.path, "utf8")).phase, "uploaded");
    edge.commitRefusal = null;
    assert.equal((await executeExactPut(await prepareExactPut(input(dir, edge)))).outcome, "committed");
    assert.equal(edge.live, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("commit access refusal can succeed after access is restored", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  edge.commitRefusal = { status: 403, code: "forbidden" };
  try {
    const first = await prepareExactPut(input(dir, edge));
    await assert.rejects(executeExactPut(first), (error: unknown) => error instanceof FileCommandRefused && error.status === 403);
    assert.equal(JSON.parse(await readFile(first.path, "utf8")).phase, "uploaded");
    edge.commitRefusal = null;
    assert.equal((await executeExactPut(await prepareExactPut(input(dir, edge)))).outcome, "committed");
    assert.equal(edge.live, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an uploaded resume record never writes an earlier phase", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  try {
    const first = await prepareExactPut(input(dir, edge));
    const broken = (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST" && JSON.parse(String(init.body)).command.kind === "file_version_commit") throw new Error("commit offline");
      return edge.fetcher(url, init);
    }) as typeof fetch;
    await assert.rejects(executeExactPut({ ...first, input: { ...first.input, fetcher: broken } }));
    assert.equal(JSON.parse(await readFile(first.path, "utf8")).phase, "uploaded");
    const observed: string[] = [];
    const resumed = await prepareExactPut(input(dir, edge, { onPhasePersisted: (phase: string) => { observed.push(phase); } }));
    await executeExactPut(resumed);
    assert.deepEqual(observed, ["uploaded", "committed"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const [shape, refusal] of [
  ["local 400 duplicate", { status: 400, body: { statusCode: "409", error: "Duplicate", message: "The resource already exists" } }],
  ["409 duplicate", { status: 409, body: { error: "Duplicate" } }],
  ["expired 403", { status: 403, body: { error: "ExpiredToken" } }],
] as const) {
  test(`replayed PUT ${shape} follows commit truth`, { timeout: 10_000 }, async () => {
    for (const present of [true, false]) {
      const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
      const edge = new FakeEdge();
      try {
        edge.putRefusal = { status: 403, body: { error: "ExpiredToken" } };
        const first = await prepareExactPut(input(dir, edge));
        await assert.rejects(executeExactPut(first), /upload PUT was refused/);
        assert.equal(edge.commits, 0, "first refused PUT never commits");
        if (present) edge.seedCreatedObject();
        edge.putRefusal = refusal;
        const resumed = await prepareExactPut(input(dir, edge));
        if (present) {
          assert.equal((await executeExactPut(resumed)).outcome, "committed");
          assert.equal(edge.live, 1);
        } else {
          await assert.rejects(executeExactPut(resumed), (error: unknown) => error instanceof FileCommandRefused && error.code === "file_bytes_missing");
          assert.equal(edge.live, 0);
        }
        assert.equal(edge.uniqueCreates, 1);
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });
}

test("two concurrent contents for one request id cannot both prepare", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  try {
    const attempts = await Promise.allSettled([
      prepareExactPut(input(dir, edge, { bytes: Buffer.from("# first\n") })),
      prepareExactPut(input(dir, edge, { bytes: Buffer.from("# second\n") })),
    ]);
    assert.equal(attempts.filter(row => row.status === "fulfilled").length, 1);
    assert.equal(attempts.filter(row => row.status === "rejected" && row.reason instanceof RequestIdConflict).length, 1);
    assert.equal(edge.creates, 0, "conflict settled before network");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("two concurrent identical puts commit one version", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  try {
    const prepared = await Promise.all([
      prepareExactPut(input(dir, edge)),
      prepareExactPut(input(dir, edge)),
    ]);
    const results = await Promise.all(prepared.map(item => executeExactPut(item)));
    assert.deepEqual(results.map(row => row.result.version_id), [results[0]!.result.version_id, results[0]!.result.version_id]);
    assert.equal(edge.uniqueCreates, 1);
    assert.equal(edge.live, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("cap and type refuse before network; brain precondition is typed", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge(); edge.precondition = 2;
  try {
    await assert.rejects(prepareExactPut(input(dir, edge, { bytes: Buffer.alloc(25 * 1024 * 1024 + 1) })), /file must contain/);
    await assert.rejects(prepareExactPut(input(dir, edge, { name: "script.sh" })), /allowed extension/);
    assert.equal(edge.creates, 0);
    const first = await prepareExactPut(input(dir, edge, { name: "brain--topic.md", ifVersion: 1 }));
    await assert.rejects(executeExactPut(first), (error: unknown) => error instanceof FileCommandRefused && error.code === "file_version_precondition_failed");
    const second = await prepareExactPut(input(dir, edge, { name: "brain--topic.md", ifVersion: 1 }));
    await assert.rejects(executeExactPut(second), (error: unknown) => error instanceof FileCommandRefused && error.code === "file_version_precondition_failed");
    assert.equal(edge.live, 0);
    const positive = await prepareExactPut(input(dir, edge, { requestId: "brain-ok-02", name: "brain--topic.md", ifVersion: 2 }));
    assert.equal((await executeExactPut(positive)).outcome, "committed");
    assert.equal(edge.live, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("expired upload URL reaches typed missing-bytes commit refusal on replay", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  try {
    let now = 1000;
    const original = edge.fetcher;
    const prepared = await prepareExactPut(input(dir, edge, { now: () => now }));
    // Crash after create, before PUT. Both internal attempts lose their answers.
    const crashed = (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "PUT") throw new Error("host stopped");
      return original(url, init);
    }) as typeof fetch;
    await assert.rejects(executeExactPut({ ...prepared, input: { ...prepared.input, fetcher: crashed } }));
    now += 2 * 60 * 60 * 1000 + 1;
    // The same create id replays an expired signed URL; commit decides whether bytes exist.
    const expired = (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "PUT") return Response.json({ error: "ExpiredToken" }, { status: 401 });
      return original(url, init);
    }) as typeof fetch;
    const retry = await prepareExactPut(input(dir, edge, { now: () => now, fetcher: expired }));
    await assert.rejects(executeExactPut(retry), (error: unknown) => error instanceof FileCommandRefused && error.code === "file_bytes_missing");
    assert.equal(edge.live, 0);
    assert.equal(edge.uniqueCreates, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("resume record advances after create, PUT, and commit", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  const original = edge.fetcher;
  try {
    const prepared = await prepareExactPut(input(dir, edge));
    const brokenPut = (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "PUT") throw new Error("storage offline");
      return original(url, init);
    }) as typeof fetch;
    await assert.rejects(executeExactPut({ ...prepared, input: { ...prepared.input, fetcher: brokenPut } }));
    assert.equal(JSON.parse(await readFile(prepared.path, "utf8")).phase, "uploaded");
    const brokenCommit = (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST" && JSON.parse(String(init.body)).command.kind === "file_version_commit") throw new Error("command offline");
      return original(url, init);
    }) as typeof fetch;
    await assert.rejects(executeExactPut({ ...prepared, input: { ...prepared.input, fetcher: brokenCommit } }));
    assert.equal(JSON.parse(await readFile(prepared.path, "utf8")).phase, "uploaded");
    const done = await executeExactPut(prepared);
    assert.equal(done.outcome, "committed");
    assert.equal(JSON.parse(await readFile(prepared.path, "utf8")).phase, "committed");
    assert.equal(edge.live, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("deleted record after create still reuses the version and discloses missing conflict history", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  const original = edge.fetcher;
  try {
    const prepared = await prepareExactPut(input(dir, edge));
    const broken = (async (url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "PUT") throw new Error("upload interrupted");
      return original(url, init);
    }) as typeof fetch;
    await assert.rejects(executeExactPut({ ...prepared, input: { ...prepared.input, fetcher: broken } }));
    await unlink(prepared.path);
    const resumed = await executeExactPut(await prepareExactPut(input(dir, edge)));
    assert.equal(resumed.conflict_check, "unavailable");
    assert.equal(edge.uniqueCreates, 1);
    assert.equal(edge.live, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("resume records stay bounded and expire at the server sweep window", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  let now = 1_000_000;
  try {
    const oldest = await prepareExactPut(input(dir, edge, { requestId: "bounded-000", now: () => now }));
    for (let index = 1; index <= 202; index++) {
      now += 1;
      await prepareExactPut(input(dir, edge, { requestId: `bounded-${String(index).padStart(3, "0")}`, now: () => now }));
    }
    assert.equal((await readdir(dir)).length, 200);
    await assert.rejects(readFile(oldest.path, "utf8"), { code: "ENOENT" });
    now += 3 * 60 * 60 * 1000 + 1;
    await prepareExactPut(input(dir, edge, { requestId: "after-sweep", now: () => now }));
    assert.equal((await readdir(dir)).length, 1);
    assert.equal(edge.creates, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("prune protects the current request record at the 200-record bound", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  try {
    await prepareExactPut(input(dir, edge, { requestId: "bounded-000", now: () => 1000 }));
    for (let index = 1; index < 200; index++) {
      await prepareExactPut(input(dir, edge, { requestId: `bounded-${String(index).padStart(3, "0")}`, now: () => 1000 + index }));
    }
    await assert.rejects(prepareExactPut(input(dir, edge, { requestId: "bounded-000", bytes: Buffer.from("different"), now: () => 1300 })), RequestIdConflict);
    assert.equal(edge.creates, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("bad JSON and wrong mode records do not block another request", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cswarm-exact-put-"));
  const edge = new FakeEdge();
  try {
    const badJson = await prepareExactPut(input(dir, edge, { requestId: "bad-json-01" }));
    await writeFile(badJson.path, "{");
    const warnings: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const badMode = await prepareExactPut(input(dir, edge, { requestId: "bad-mode-01" }));
      await chmod(badMode.path, 0o644);
      const good = await prepareExactPut(input(dir, edge, { requestId: "good-new-01" }));
      assert.equal(good.record.phase, "prepared");
      await prepareExactPut(input(dir, edge, { requestId: "good-next-02" }));
      await assert.rejects(readFile(badJson.path), { code: "ENOENT" });
      await assert.rejects(readFile(badMode.path), { code: "ENOENT" });
    } finally { process.stderr.write = originalWrite; }
    assert.equal(warnings.length, 2, "each bad record is reported once and then quarantined");
    for (const warning of warnings) assert.match(warning, /skipped unreadable file put resume record/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

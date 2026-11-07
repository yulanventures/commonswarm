import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getMemoryAsAgent,
  MemoryError,
  memoryEvidenceHref,
  memorySaveProblem,
  memorySubject,
  searchMemoriesAsAgent,
  sendMemoryCommand,
} from "../src/cloud/memory.js";
import { fitRows, MCP_RESULT_MAX_BYTES, validateMcpArguments } from "../src/mcp/tools.js";

const target = { url: "https://api.example.test", anonKey: "anon" } as never;
const workspace = "11111111-1111-4111-8111-111111111111";
const memoryId = "22222222-2222-4222-8222-222222222222";
const memory = { memory_id: memoryId, subject: "release day", kind: "convention", statement: "Tuesdays.", evidence: [], revision: 2 };

function recorder(replies: Array<Response | Error>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = replies.shift();
    if (next === undefined) throw new Error("no more replies");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test("subjects and saves are checked with the server's own rules", () => {
  assert.deepEqual(memorySubject("  Release   Day "), { subject: "release day" });
  assert.ok("problem" in memorySubject("-leading hyphen"));
  assert.ok("problem" in memorySubject("x".repeat(121)));
  const base = { kind: "fact" as const, subject: "release day", statement: "Tuesdays.", evidence: [] };
  assert.equal(memorySaveProblem(base), null);
  assert.match(memorySaveProblem({ ...base, kind: "rule" as never })!, /decision, convention, ownership, fact/);
  assert.match(memorySaveProblem({ ...base, statement: "x".repeat(1001) })!, /1 to 1000/);
  assert.match(memorySaveProblem({ ...base, evidence: ["http://example.com"] })!, /https URL/);
  assert.match(memorySaveProblem({ ...base, evidence: ["https://user:pw@example.com"] })!, /https URL/);
  assert.match(memorySaveProblem({ ...base, evidence: Array(6).fill("https://example.com") })!, /at most 5/);
  assert.match(memorySaveProblem({ ...base, expected_revision: 0 })!, /positive whole number/);
  assert.equal(memoryEvidenceHref("https://Example.com"), "https://example.com/", "sent as the server compares it");
});

test("a save sends only the memory fields, canonical links, and the outcome comes back", async () => {
  const { calls, fetcher } = recorder([reply(200, { ok: true, memory: memory, memory_outcome: "updated", previous_statement: "Mondays." })]);
  const result = await sendMemoryCommand(target, "swm_agt_x", workspace, {
    kind: "memory_save",
    input: { kind: "convention", subject: "release day", statement: "Tuesdays.", evidence: ["https://Example.com"], expected_revision: 1 },
  }, fetcher);
  assert.equal(result.memory_outcome, "updated");
  assert.equal(result.previous_statement, "Mondays.");
  assert.equal(calls[0]!.url, "https://api.example.test/functions/v1/command");
  assert.deepEqual(calls[0]!.body.command, {
    kind: "memory_save", memory_kind: "convention", subject: "release day", statement: "Tuesdays.",
    evidence: ["https://example.com/"], expected_revision: 1,
  });
  assert.equal(calls[0]!.body.workspace_id, workspace);
});

test("a save with no answer is resent once with the same command id", async () => {
  const { calls, fetcher } = recorder([new TypeError("socket hang up"), reply(200, { memory, memory_outcome: "created" })]);
  const result = await sendMemoryCommand(target, "swm_agt_x", workspace, { kind: "memory_forget", memory_id: memoryId.toUpperCase() }, fetcher);
  assert.equal(result.memory_outcome, "created");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body.command_id, calls[1]!.body.command_id);
  assert.deepEqual(calls[0]!.body.command, { kind: "memory_forget", memory_id: memoryId });

  const silent = recorder([new TypeError("down"), new TypeError("down")]);
  await assert.rejects(
    sendMemoryCommand(target, "swm_agt_x", workspace, { kind: "memory_forget", memory_id: memoryId }, silent.fetcher),
    (error: unknown) => error instanceof MemoryError && error.noResponse && /outcome is unknown/.test(error.message),
  );
});

test("a save that hits an existing subject carries that memory in the refusal", async () => {
  const { fetcher } = recorder([reply(409, { error: "memory_exists", message: "A memory with that subject already exists.", memory })]);
  await assert.rejects(
    sendMemoryCommand(target, "swm_agt_x", workspace, {
      kind: "memory_save", input: { kind: "convention", subject: "release day", statement: "Fridays.", evidence: [] },
    }, fetcher),
    (error: unknown) => error instanceof MemoryError && error.code === "memory_exists" && error.memory?.revision === 2,
  );
  const off = recorder([reply(404, { error: "memory_unavailable" })]);
  await assert.rejects(searchMemoriesAsAgent(target, "swm_agt_x", workspace, {}, off.fetcher),
    (error: unknown) => error instanceof MemoryError && error.code === "memory_unavailable" && /isn't turned on/.test(error.message));
});

test("reads go to the read edge and keep the untrusted marker", async () => {
  const { calls, fetcher } = recorder([
    reply(200, { workspace_id: workspace, untrusted_content: true, memories: [memory] }),
    reply(200, { workspace_id: workspace, untrusted_content: true, memory, versions: [{ revision: 1, action: "save" }] }),
  ]);
  const page = await searchMemoriesAsAgent(target, "swm_agt_x", workspace, { query: "  tues ", limit: 5 }, fetcher);
  assert.equal(page.untrusted_content, true);
  assert.deepEqual(calls[0]!.body, { resource: "memory_search", workspace_id: workspace, query: "tues", limit: 5 });
  const detail = await getMemoryAsAgent(target, "swm_agt_x", workspace, memoryId.toUpperCase(), fetcher);
  assert.equal(detail.memory.memory_id, memoryId);
  assert.deepEqual(calls[1]!.body, { resource: "memory_get", workspace_id: workspace, memory_id: memoryId });
  assert.equal(calls[1]!.url, "https://api.example.test/functions/v1/read");
});

test("the MCP memory tools validate enums, arrays and integers; channel_read takes an integer limit", () => {
  const save = { kind: "decision", subject: "release day", statement: "Tuesdays." };
  assert.deepEqual(validateMcpArguments("memory_save", { ...save, evidence: ["https://example.com"], expected_revision: 3 }),
    { ...save, evidence: ["https://example.com"], expected_revision: 3 });
  for (const bad of [
    { ...save, kind: "rule" }, { ...save, evidence: "https://example.com" }, { ...save, evidence: Array(6).fill("https://a.b") },
    { ...save, evidence: [7] }, { ...save, expected_revision: 0 }, { ...save, expected_revision: "3" }, { ...save, statement: "" },
  ]) {
    assert.throws(() => validateMcpArguments("memory_save", bad), /Invalid argument/, JSON.stringify(bad));
  }
  assert.throws(() => validateMcpArguments("memory_save", { kind: "fact", subject: "x" }), /Missing argument: statement/);
  assert.deepEqual(validateMcpArguments("memory_search", { query: "tues", limit: 50 }), { query: "tues", limit: 50 });
  assert.throws(() => validateMcpArguments("memory_search", { limit: 51 }), /Invalid argument: limit/);
  assert.throws(() => validateMcpArguments("memory_get", { memory_id: "nope" }), /Invalid argument: memory_id/);
  assert.deepEqual(validateMcpArguments("channel_read", { channel: "general", limit: 10 }), { channel: "general", limit: 10 });
});

test("a large memory result drops rows to fit the MCP cap and says so", () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ ...memory, memory_id: String(index), statement: "x".repeat(1000) }));
  const fitted = fitRows({ workspace_id: workspace, untrusted_content: true, memories: rows }, "memories", "Narrow with query.") as {
    memories: unknown[]; truncated?: boolean; untrusted_content: boolean;
  };
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= MCP_RESULT_MAX_BYTES);
  assert.ok(fitted.memories.length > 0 && fitted.memories.length < 50);
  assert.equal(fitted.truncated, true);
  assert.equal(fitted.untrusted_content, true);
  const small = { memories: rows.slice(0, 2) };
  assert.equal(fitRows(small, "memories", "n/a"), small, "a result that fits is unchanged");
});

/**
 * Observing surfaced deliveries: the edge's acted-signal observation (a reply or a reaction
 * observes the actor's own unclaimed delivery) and the client's batched observation with its
 * fallback to the single shape an older edge accepts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignalRecord } from "../src/cloud/command-client.js";
import { cloudTarget } from "../src/cloud/config.js";
import { DeliveryCommandClient, DeliveryMalformedResponseError } from "../src/cloud/delivery.js";
import {
  observeSurfacedDeliveries,
  observeUnclaimedDeliveries,
  OBSERVATION_FALLBACK_CONCURRENCY,
  surfacedDeliveryIds,
} from "../src/cloud/delivery-observation.js";
import { observeUnclaimedDeliveryForActedSignal } from "../supabase/functions/command/durable-delivery.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER = "55555555-5555-4555-8555-555555555555";
const SIGNAL = "33333333-3333-4333-8333-333333333333";
const TOKEN = "swm_agt_" + "A".repeat(43);
const target = cloudTarget("https://cloud.example.test", "anon-key");

type Row = {
  acked_at: Date | null; ack_outcome: string | null; lease_id: string | null; leased_by: string | null;
  last_lease_id: string | null; last_leased_by: string | null;
  session_id: string | null; session_generation: number | null;
};
const fresh = (): Row => ({ acked_at: null, ack_outcome: null, lease_id: null, leased_by: null,
  last_lease_id: null, last_leased_by: null, session_id: null, session_generation: null });

/** A postgres.js transaction stand-in: the delivery row, the directed answer, and a log of every query. */
function fakeTx(row: Row | undefined, options: { directed?: boolean; failOn?: string } = {}) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const tx = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join("?");
    queries.push({ text, values });
    if (options.failOn && text.includes(options.failOn)) {
      return Promise.reject(Object.assign(new Error("lock not available"), { code: "55P03" }));
    }
    if (text.includes("FROM swarm.signal_deliveries")) return Promise.resolve(row ? [row] : []);
    if (text.includes("SELECT EXISTS")) return Promise.resolve([{ allowed: options.directed ?? true }]);
    if (text.includes("UPDATE swarm.signal_deliveries")) return Promise.resolve(Object.assign([], { count: 1 }));
    throw new Error(`unexpected query: ${text}`);
  }) as unknown as Parameters<typeof observeUnclaimedDeliveryForActedSignal>[0];
  (tx as unknown as { savepoint: unknown }).savepoint = async (run: (sp: unknown) => Promise<unknown>) => await run(tx);
  return { tx, queries, updates: () => queries.filter(q => q.text.includes("UPDATE swarm.signal_deliveries")).length };
}

const args = { workspaceId: WORKSPACE, recipientPrincipalId: AGENT, signalId: SIGNAL, managed: false, proof: null };

test("an agent's reply or reaction observes its own untouched delivery, skipping a row someone holds", async () => {
  const fake = fakeTx(fresh());
  assert.equal(await observeUnclaimedDeliveryForActedSignal(fake.tx, args), true);
  assert.equal(fake.updates(), 1);
  const select = fake.queries[0]!;
  assert.match(select.text, /FOR UPDATE SKIP LOCKED/, "never waits behind another holder of the row");
  assert.deepEqual(select.values, [WORKSPACE, SIGNAL, AGENT], "the acting agent's own row in this workspace");
  const update = fake.queries.find(q => q.text.includes("UPDATE swarm.signal_deliveries"))!;
  assert.match(update.text, /ack_outcome = 'observed'/);
  assert.match(update.text, /ack_via = COALESCE\(ack_via, 'unclaimed'\)/);
  assert.deepEqual(update.values, [WORKSPACE, SIGNAL, AGENT]);
});

test("a leased, once-leased, queued or acked delivery is left exactly as it is", async () => {
  for (const change of [
    { lease_id: "lease", leased_by: "listener" },
    { last_lease_id: "lease", last_leased_by: "listener" },
    { ack_outcome: "queued", acked_at: new Date() },
    { ack_outcome: "observed", acked_at: new Date() },
    { ack_outcome: "replied", acked_at: new Date(), last_lease_id: "lease", last_leased_by: "listener" },
  ] satisfies Partial<Row>[]) {
    const fake = fakeTx({ ...fresh(), ...change });
    assert.equal(await observeUnclaimedDeliveryForActedSignal(fake.tx, args), false, JSON.stringify(change));
    assert.equal(fake.updates(), 0, JSON.stringify(change));
    assert.equal(fake.queries.length, 1, "no directed check either");
  }
  // No row (not a recipient, another workspace, or held by another transaction): nothing happens.
  const none = fakeTx(undefined);
  assert.equal(await observeUnclaimedDeliveryForActedSignal(none.tx, args), false);
  assert.equal(none.updates(), 0);
});

test("a message the agent may no longer observe, or a managed session mismatch, writes nothing", async () => {
  const hidden = fakeTx(fresh(), { directed: false });
  assert.equal(await observeUnclaimedDeliveryForActedSignal(hidden.tx, args), false);
  assert.equal(hidden.updates(), 0);
  const managed = { ...args, managed: true };
  const noProof = fakeTx(fresh());
  assert.equal(await observeUnclaimedDeliveryForActedSignal(noProof.tx, managed), false);
  assert.equal(noProof.updates(), 0);
  const bound = fakeTx({ ...fresh(), session_id: "session-b", session_generation: 2 });
  assert.equal(await observeUnclaimedDeliveryForActedSignal(bound.tx, { ...managed, proof: { session_id: "session-a", generation: 2 } }), false);
  assert.equal(bound.updates(), 0);
  const same = fakeTx({ ...fresh(), session_id: "session-a", session_generation: 2 });
  assert.equal(await observeUnclaimedDeliveryForActedSignal(same.tx, { ...managed, proof: { session_id: "session-a", generation: 2 } }), true);
});

test("a failed observation reports only its SQLSTATE and never throws into the acting command", async () => {
  const fake = fakeTx(fresh(), { failOn: "UPDATE" });
  const codes: Array<string | null> = [];
  assert.equal(await observeUnclaimedDeliveryForActedSignal(fake.tx, args, code => codes.push(code)), false);
  assert.deepEqual(codes, ["55P03"]);
  // A throwing logger changes nothing either.
  assert.equal(await observeUnclaimedDeliveryForActedSignal(fakeTx(fresh(), { failOn: "UPDATE" }).tx, args,
    () => { throw new Error("log down"); }), false);
});

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${String(i + 1).padStart(8, "0")}-1111-4111-8111-111111111111`);
}

/** A command edge stand-in that answers ack_agent_delivery in either shape. */
function edge(options: { oldEdge?: boolean; batchStatus?: number; singleStatus?: (id: string) => number; delayMs?: number } = {}) {
  const commands: Array<Record<string, unknown>> = [];
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)).command as Record<string, unknown>;
    commands.push(command);
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
    if (Array.isArray(command.signal_ids)) {
      if (options.oldEdge) return json(400, { error: "invalid_request", message: "ack_agent_delivery fields are malformed" });
      const status = options.batchStatus ?? 200;
      if (status !== 200) return json(status, { error: status === 409 ? "session_conflict" : "temporarily_unavailable" });
      const [first, ...rest] = command.signal_ids as string[];
      return json(200, { status: "accepted", ok: true, event_ids: [], outcome: "observed", signal_ids: command.signal_ids,
        observed_signal_ids: rest, refused: [{ signal_id: first, error: "delivery_unavailable" }] });
    }
    inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    try {
      await new Promise(resolveDelay => setTimeout(resolveDelay, options.delayMs ?? 5));
    } finally { inFlight--; }
    const status = options.singleStatus?.(String(command.signal_id)) ?? 200;
    return status === 200
      ? json(200, { status: "accepted", ok: true, event_ids: [], signal_id: command.signal_id, outcome: "observed" })
      : json(status, { error: status === 409 ? "delivery_ack_conflict" : "temporarily_unavailable" });
  }) as typeof fetch;
  return { fetcher, commands, stats };
}

const observe = (fetcher: typeof fetch, signalIds: string[], deadlineAtMs = Date.now() + 5_000) =>
  observeUnclaimedDeliveries({ target, fetcher, credential: TOKEN, workspaceId: WORKSPACE, signalIds, deadlineAtMs });

test("ids go in batches of at most fifty, and each id answers once", async () => {
  const fake = edge();
  const all = ids(120);
  const outcome = await observe(fake.fetcher, all);
  assert.deepEqual(fake.commands.map(command => (command.signal_ids as string[]).length), [50, 50, 20]);
  assert.deepEqual(fake.commands[0], { kind: "ack_agent_delivery", signal_ids: all.slice(0, 50), lease_id: null,
    listener_instance_id: null, outcome: "observed", last_error_code: null, surfaced: true, unclaimed: true });
  assert.equal(outcome.fellBack, false);
  assert.deepEqual([...outcome.observed, ...outcome.refused].sort(), all);
  assert.deepEqual(outcome.refused, [all[0], all[50], all[100]]);
  assert.deepEqual(outcome.failed, []);
});

test("an older edge's 400 drops nothing: each id goes again in the single shape, four at a time", async () => {
  const all = ids(60);
  const fake = edge({ oldEdge: true, delayMs: 20, singleStatus: id => id === all[1] ? 409 : id === all[2] ? 503 : 200 });
  const outcome = await observe(fake.fetcher, all);
  assert.equal(outcome.fellBack, true);
  assert.equal(fake.commands.filter(command => Array.isArray(command.signal_ids)).length, 1,
    "the batch shape is tried once per call, not once per chunk");
  assert.deepEqual(fake.commands.filter(command => typeof command.signal_id === "string").map(c => c.signal_id).sort(), all);
  assert.equal(fake.stats.maxInFlight, OBSERVATION_FALLBACK_CONCURRENCY);
  assert.deepEqual(outcome.refused, [all[1]], "a 409 is final");
  assert.deepEqual(outcome.failed, [all[2]], "a 503 is retried later");
  assert.equal(outcome.observed.length, all.length - 2);
});

test("a whole batch refused 403/404/409 is final for each id; anything else is retried later", async () => {
  for (const [status, bucket] of [[403, "refused"], [404, "refused"], [409, "refused"], [401, "failed"], [429, "failed"], [503, "failed"]] as const) {
    const outcome = await observe(edge({ batchStatus: status }).fetcher, ids(3));
    assert.deepEqual(outcome[bucket], ids(3), String(status));
  }
});

test("past its deadline the observation sends nothing and reports every id for retry", async () => {
  const fake = edge();
  const outcome = await observe(fake.fetcher, ids(3), Date.now() - 1);
  assert.deepEqual(outcome.failed, ids(3));
  assert.equal(fake.commands.length, 0);
});

test("the batch answer must name each requested id exactly once", async () => {
  const lying = (async () => new Response(JSON.stringify({ status: "accepted", ok: true, event_ids: [], outcome: "observed",
    signal_ids: [SIGNAL], observed_signal_ids: [SIGNAL, OTHER], refused: [] }), { status: 200 })) as typeof fetch;
  await assert.rejects(new DeliveryCommandClient(target, lying).observeUnclaimedAgentDeliveries({
    workspaceId: WORKSPACE, credential: TOKEN, commandId: "observe-batch-1", signalIds: [SIGNAL],
  }), DeliveryMalformedResponseError);
  await assert.rejects(new DeliveryCommandClient(target, lying).observeUnclaimedAgentDeliveries({
    workspaceId: WORKSPACE, credential: TOKEN, commandId: "observe-batch-2", signalIds: ids(51),
  }), /1\.\.50/);
});

function row(id: string, extra: Partial<SignalRecord> = {}): SignalRecord {
  return { id, workspace_id: WORKSPACE, from: OTHER, from_kind: "user", to: null, to_agent: null, in_reply_to: null,
    about: null, kind: "note", body: "x", until: "2099-01-01T00:00:00.000Z", created_at: "2026-11-17T00:00:00.000Z",
    ...extra } as SignalRecord;
}

test("surfaced ids: asks and notes that reach the agent, never a reaction note, and on request never its own", () => {
  const [a, b, c, d, e, f] = ids(6);
  const rows = [
    row(a!, { to_agent: AGENT, kind: "ask" }),
    row(b!, { mentions: [{ position: 0, kind: "agent", id: AGENT, source: "author" }] } as Partial<SignalRecord>),
    row(c!, { to_agent: OTHER }),
    row(d!, { to_agent: AGENT, kind: "working-on" }),
    row(e!, { to_agent: AGENT, from: AGENT, from_kind: "agent" }),
    row(f!, { to_agent: AGENT, reaction: { emoji: "x" } } as unknown as Partial<SignalRecord>),
  ];
  assert.deepEqual(surfacedDeliveryIds(rows, AGENT), [a, b, e]);
  assert.deepEqual(surfacedDeliveryIds(rows, AGENT, { excludeOwn: true }), [a, b]);
  assert.deepEqual(surfacedDeliveryIds(rows, null), [a, b, c, e], "a bare token names every ask and note; the edge refuses the rest");
});

test("observing what was printed never throws and stops when its signal aborts", async () => {
  assert.equal(await observeSurfacedDeliveries({ target, fetcher: edge().fetcher, credential: TOKEN, workspaceId: WORKSPACE,
    signalIds: [] }), null);
  const broken = (async () => { throw new TypeError("network down"); }) as typeof fetch;
  const failed = await observeSurfacedDeliveries({ target, fetcher: broken, credential: TOKEN, workspaceId: WORKSPACE,
    signalIds: [SIGNAL] });
  assert.deepEqual(failed?.failed, [SIGNAL]);
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await observeSurfacedDeliveries({ target, fetcher: edge().fetcher, credential: TOKEN, workspaceId: WORKSPACE,
    signalIds: [SIGNAL], signal: stopped.signal }), null);
});

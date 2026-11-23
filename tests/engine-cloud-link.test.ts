import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../src/cloud/agent-credential-input.js";
import { CONNECT_PROFILE_FILES } from "../src/cloud/connect-profile-files.js";
import {
  AGENT_SESSION_GENERATION_HEADER,
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_KEY_HEADER,
  AGENT_SESSION_RENEW_AFTER_MS,
} from "../src/cloud/session-contract.js";
import {
  CloudLinkError,
  openCloudLink,
  type OpenCloudLinkOptions,
  type TimerClear,
  type TimerSet,
} from "../src/engine/cloud-link.js";
import { AuthorityLostError, type Clock, type HarnessPort } from "../src/engine/ports.js";
import { EngineRunner } from "../src/engine/runner.js";

const BASE_URL = "http://127.0.0.1:9999";
const ANON_KEY = "synthetic-anon-key";
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NEXT_TOKEN_ID = "11111111-1111-4111-8111-111111111111";
const SENDER_ID = "22222222-2222-4222-8222-222222222222";
const BEARER = `swm_agt_${"A".repeat(43)}`;
const NEXT_BEARER = `swm_agt_${"B".repeat(43)}`;
const MESSAGE_SECRET_BODY = "TOP_SECRET_MESSAGE_BODY_XYZ987";
const REPLY_SECRET_BODY = "TOP_SECRET_REPLY_BODY_QRS654";

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly commandKind: string | null;
  readonly commandId: string | null;
  readonly proofHeaders: readonly string[];
  readonly generationHeader: string | null;
  readonly atMs: number;
}

class FakeClock implements Clock {
  private current: number;
  private nextId = 1;
  private readonly timers = new Map<number, { due: number; fn: () => void }>();

  constructor(startMs = Date.parse("2026-11-23T12:00:00.000Z")) {
    this.current = startMs;
  }

  now(): number { return this.current; }

  readonly setTimer: TimerSet = (callback, ms) => {
    const id = this.nextId++;
    this.timers.set(id, { due: this.current + Math.max(0, ms), fn: callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  readonly clearTimer: TimerClear = (timer) => {
    this.timers.delete(timer as unknown as number);
  };

  pendingCount(): number { return this.timers.size; }

  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    while (true) {
      let next: { id: number; due: number; fn: () => void } | null = null;
      for (const [id, entry] of this.timers) {
        if (entry.due <= target && (next === null || entry.due < next.due || (entry.due === next.due && id < next.id))) {
          next = { id, due: entry.due, fn: entry.fn };
        }
      }
      if (next === null) break;
      this.timers.delete(next.id);
      this.current = next.due;
      next.fn();
      await settleIo();
    }
    this.current = target;
    await settleIo();
  }
}

async function settleIo(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitUntil(predicate: () => boolean, maxTicks = 500): Promise<void> {
  for (let i = 0; i < maxTicks && !predicate(); i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface FakeDelivery {
  signalId: string;
  leaseId: string;
  body: string;
  kind?: string;
  threadRootId?: string | null;
  rawOverride?: Record<string, unknown>;
}

interface FakeEdgeOptions {
  clock: FakeClock;
  generation?: number;
  readResponse?: { status: number; body: Record<string, unknown> };
  agentRow?: Record<string, unknown>;
  acquireErrors?: Array<{ status: number; error: string }>;
  deliveries?: Array<FakeDelivery | null>;
  claimHandler?: (body: Record<string, unknown>, headers: Headers) => Response | null;
  ackHandler?: (body: Record<string, unknown>, headers: Headers) => Response | null;
  postHandler?: (body: Record<string, unknown>, headers: Headers) => Response | null;
  onPostAccepted?: (count: number) => void;
  renewHandler?: (body: Record<string, unknown>, headers: Headers) => Response | null;
  releaseHandler?: (body: Record<string, unknown>, headers: Headers) => Response | null;
}

function makeFakeEdge(opts: FakeEdgeOptions) {
  const requests: RecordedRequest[] = [];
  const observedProofSessionIds: string[] = [];
  const observedSessionKeys: string[] = [];
  const acked: Array<{ signalId: string; leaseId: string; outcome: string; surfaced: unknown }> = [];
  const posted: Array<{ commandId: string; command: Record<string, unknown> }> = [];
  const postedByCommandId = new Map<string, { payload: string; signal: Record<string, unknown> }>();
  let generation = opts.generation ?? 7;
  let signalCounter = 1;
  const acquireQueue = [...(opts.acquireErrors ?? [])];
  const deliveryQueue = [...(opts.deliveries ?? [])];

  const json = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const makeSignalPayload = (d: FakeDelivery) => ({
    signal: {
      id: d.signalId,
      workspace_id: WORKSPACE_ID,
      from: SENDER_ID,
      from_kind: "user",
      to: null,
      to_agent: PRINCIPAL_ID,
      in_reply_to: null,
      about: null,
      kind: d.kind ?? "ask",
      body: d.body,
      until: new Date(opts.clock.now() + 3_600_000).toISOString(),
      created_at: new Date(opts.clock.now()).toISOString(),
      ...(d.threadRootId !== undefined ? { thread_root_id: d.threadRootId } : {}),
      ...(d.rawOverride ?? {}),
    },
    lease_id: d.leaseId,
    leased_until: new Date(opts.clock.now() + 900_000).toISOString(),
    sender_owner_relation: "same_owner",
  });

  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers = new Headers(init?.headers);
    const parsed = typeof init?.body === "string" && init.body.length > 0
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};
    const cmd = parsed.command && typeof parsed.command === "object"
      ? (parsed.command as Record<string, unknown>)
      : null;
    const commandKind = typeof cmd?.kind === "string" ? cmd.kind : null;
    const commandId = typeof parsed.command_id === "string" ? parsed.command_id : null;
    const proofHeaders = [AGENT_SESSION_ID_HEADER, AGENT_SESSION_GENERATION_HEADER, AGENT_SESSION_KEY_HEADER]
      .filter((name) => headers.has(name));
    const keyVal = headers.get(AGENT_SESSION_KEY_HEADER);
    if (keyVal) observedSessionKeys.push(keyVal);
    const sidVal = headers.get(AGENT_SESSION_ID_HEADER);
    if (sidVal) observedProofSessionIds.push(sidVal);
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      commandKind,
      commandId,
      proofHeaders,
      generationHeader: headers.get(AGENT_SESSION_GENERATION_HEADER),
      atMs: opts.clock.now(),
    });

    if (url.pathname === "/functions/v1/read") {
      if (opts.readResponse) return json(opts.readResponse.status, opts.readResponse.body);
      return json(200, {
        members: [{ user_id: OWNER_ID, display_name: "Owner" }],
        agents: [{
          principal_id: PRINCIPAL_ID,
          name: "Engine Test",
          transport: "local",
          turn_only: false,
          owner_user_id: OWNER_ID,
          ...(opts.agentRow ?? {}),
        }],
        identity: {
          credential_valid: true,
          principal_id: PRINCIPAL_ID,
          run_id: RUN_ID,
          owner_user_id: OWNER_ID,
          workspace_id: WORKSPACE_ID,
          managed_at: "2026-11-23T00:00:00.000Z",
        },
      });
    }

    if (url.pathname === "/functions/v1/command" && cmd !== null) {
      if (commandKind === "acquire_agent_session") {
        const err = acquireQueue.shift();
        if (err) return json(err.status, { error: err.error });
        return json(200, { ok: true, status: "accepted", generation });
      }
      if (commandKind === "renew_agent_session") {
        const custom = opts.renewHandler?.(parsed, headers);
        if (custom) return custom;
        return json(200, { ok: true, status: "accepted", generation });
      }
      if (commandKind === "release_agent_session") {
        const custom = opts.releaseHandler?.(parsed, headers);
        if (custom) return custom;
        return json(200, { ok: true, status: "accepted" });
      }
      if (commandKind === "renew_agent_token") {
        const nowIso = new Date().toISOString();
        const expIso = new Date(Date.now() + 3_600_000).toISOString();
        return json(200, {
          ok: true,
          status: "accepted",
          agent_token: NEXT_BEARER,
          token_id: NEXT_TOKEN_ID,
          run_id: RUN_ID,
          principal_id: PRINCIPAL_ID,
          issued_at: nowIso,
          expires_at: expIso,
        });
      }
      if (commandKind === "claim_agent_inbox") {
        const custom = opts.claimHandler?.(parsed, headers);
        if (custom) return custom;
        const next = deliveryQueue.shift() ?? null;
        const deliveries = next === null ? [] : [makeSignalPayload(next)];
        return json(200, {
          ok: true,
          status: "accepted",
          capabilities: { delivery_claim: 1, delivery_ack: 1, sender_owner_relation: 1 },
          deliveries,
          pending_delivery_count: deliveries.length,
          terminal_delivery_failure_count: 0,
        });
      }
      if (commandKind === "ack_agent_delivery") {
        acked.push({
          signalId: String(cmd.signal_id ?? ""),
          leaseId: String(cmd.lease_id ?? ""),
          outcome: String(cmd.outcome ?? ""),
          surfaced: cmd.surfaced,
        });
        const custom = opts.ackHandler?.(parsed, headers);
        if (custom) return custom;
        return json(200, {
          ok: true,
          status: "accepted",
          event_ids: [],
          signal_id: cmd.signal_id,
          outcome: cmd.outcome,
        });
      }
      if (commandKind === "post_signal") {
        const custom = opts.postHandler?.(parsed, headers);
        if (custom) return custom;
        const cid = commandId ?? "";
        const canonical = JSON.stringify(cmd);
        const prior = postedByCommandId.get(cid);
        if (prior) {
          if (prior.payload !== canonical) return json(409, { error: "command_id_conflict" });
          return json(200, { ok: true, status: "accepted", event_ids: [], signal: prior.signal });
        }
        const sig = {
          id: `33333333-3333-4333-8333-${String(signalCounter++).padStart(12, "0")}`,
          workspace_id: WORKSPACE_ID,
          from: PRINCIPAL_ID,
          from_kind: "agent",
          to: null,
          to_agent: null,
          in_reply_to: cmd.in_reply_to ?? null,
          about: null,
          kind: "note",
          body: String(cmd.body ?? ""),
          until: new Date(opts.clock.now() + 3_600_000).toISOString(),
          created_at: new Date(opts.clock.now()).toISOString(),
        };
        postedByCommandId.set(cid, { payload: canonical, signal: sig });
        posted.push({ commandId: cid, command: cmd });
        opts.onPostAccepted?.(posted.length);
        return json(200, { ok: true, status: "accepted", event_ids: [], signal: sig });
      }
    }
    return json(404, { error: "not_found" });
  }) as typeof fetch;

  return {
    fetcher,
    requests,
    acked,
    posted,
    observedSessionKeys,
    observedProofSessionIds,
    pushDelivery(d: FakeDelivery) { deliveryQueue.push(d); },
  };
}

async function withIsolatedProfile<T>(
  config: { expiresAt?: string; linkJoinedMarker?: boolean },
  fn: (ctx: { root: string; profilePath: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "cswarm-cloud-link-"));
  await chmod(root, 0o700);
  const stateDir = join(root, "state");
  await mkdir(stateDir, { mode: 0o700 });
  await chmod(stateDir, 0o700);
  const profileDir = join(root, "profile");
  await mkdir(profileDir, { mode: 0o700 });
  await chmod(profileDir, 0o700);
  const credPath = join(profileDir, CONNECT_PROFILE_FILES.credential);
  const profilePath = join(profileDir, "profile.json");
  const credDoc: Record<string, unknown> = {
    message: AGENT_CREDENTIAL_MESSAGE_D088,
    status: "accepted",
    principal_id: PRINCIPAL_ID,
    token_id: TOKEN_ID,
    run_id: RUN_ID,
    agent_token: BEARER,
    ...(config.expiresAt !== undefined ? { expires_at: config.expiresAt } : {}),
  };
  await writeFile(credPath, `${JSON.stringify(credDoc)}\n`, { mode: 0o600 });
  await chmod(credPath, 0o600);
  await writeFile(profilePath, `${JSON.stringify({
    version: 1,
    url: BASE_URL,
    anon_key: ANON_KEY,
    workspace_id: WORKSPACE_ID,
    principal_id: PRINCIPAL_ID,
    credential_file: credPath,
  })}\n`, { mode: 0o600 });
  await chmod(profilePath, 0o600);
  if (config.linkJoinedMarker) {
    const markerPath = join(profileDir, CONNECT_PROFILE_FILES.attemptMarker);
    await writeFile(markerPath, JSON.stringify({ attemptId: "99999999-9999-4999-8999-999999999999" }), { mode: 0o600 });
    await chmod(markerPath, 0o600);
  }
  const prevStateDir = process.env.SWARM_AGENT_STATE_DIR;
  process.env.SWARM_AGENT_STATE_DIR = stateDir;
  try {
    return await fn({ root, profilePath });
  } finally {
    if (prevStateDir === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
    else process.env.SWARM_AGENT_STATE_DIR = prevStateDir;
    await rm(root, { recursive: true, force: true });
  }
}

function baseOptions(
  profilePath: string,
  edge: ReturnType<typeof makeFakeEdge>,
  clock: FakeClock,
  overrides: Partial<OpenCloudLinkOptions> = {},
): OpenCloudLinkOptions {
  return {
    profilePath,
    onAuthorityLost: () => {},
    takeoverWaitMs: 5_000,
    takeoverRetryMs: 500,
    pollMinMs: 100,
    pollMaxMs: 800,
    fetch: edge.fetcher,
    clock,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  };
}

test("1. open acquires with id+key and no generation, binds all three proof headers later, and never renews credential before acquire", async () => {
  // Set expires_at inside the 5-minute renewal lead window so renewal runs as soon as bearer() is called.
  const soonIso = new Date(Date.now() + 60_000).toISOString();
  await withIsolatedProfile({ expiresAt: soonIso }, async ({ profilePath }) => {
    const clock = new FakeClock();
    const msgId = "44444444-4444-4444-8444-444444444441";
    const leaseId = "55555555-5555-4555-8555-555555555551";
    const edge = makeFakeEdge({
      clock,
      generation: 11,
      deliveries: [{ signalId: msgId, leaseId, body: "hello" }],
    });
    const link = await openCloudLink(baseOptions(profilePath, edge, clock));
    try {
      const acqIdx = edge.requests.findIndex((r) => r.commandKind === "acquire_agent_session");
      assert.ok(acqIdx >= 0, "acquire_agent_session must be called");
      const acq = edge.requests[acqIdx]!;
      assert.deepEqual(acq.proofHeaders, [AGENT_SESSION_ID_HEADER, AGENT_SESSION_KEY_HEADER]);
      assert.equal(acq.generationHeader, null);
      assert.equal(
        edge.requests.slice(0, acqIdx + 1).some((r) => r.commandKind === "renew_agent_token"),
        false,
        "credential renewal must never be attempted before acquire",
      );

      const msg = await link.port.claim();
      assert.equal(msg?.id, msgId);
      await link.port.markSeen(msgId, leaseId);
      await link.port.postReply({
        commandId: "cmd_reply_0001",
        replyTarget: { kind: "private", inReplyTo: msgId },
        status: "answered",
        body: "done",
      });

      const afterAcquire = edge.requests.slice(acqIdx + 1);
      assert.ok(afterAcquire.some((r) => r.commandKind === "renew_agent_token"), "credential should renew after acquire");
      assert.ok(afterAcquire.some((r) => r.commandKind === "claim_agent_inbox"));
      assert.ok(afterAcquire.some((r) => r.commandKind === "ack_agent_delivery"));
      assert.ok(afterAcquire.some((r) => r.commandKind === "post_signal"));
      for (const req of afterAcquire) {
        assert.deepEqual(req.proofHeaders, [
          AGENT_SESSION_ID_HEADER,
          AGENT_SESSION_GENERATION_HEADER,
          AGENT_SESSION_KEY_HEADER,
        ]);
        assert.equal(req.generationHeader, "11");
      }
    } finally {
      await link.close();
    }
  });
});

test("2. hosted, link-joined and turn-only seats are refused with seat_unsupported before any claim", async () => {
  // Hosted via 403 transport_unavailable on read
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    const edge = makeFakeEdge({ clock, readResponse: { status: 403, body: { error: "transport_unavailable" } } });
    await assert.rejects(
      () => openCloudLink(baseOptions(profilePath, edge, clock)),
      (err: unknown) => err instanceof CloudLinkError && err.code === "seat_unsupported" && err.seatKind === "hosted",
    );
    assert.equal(edge.requests.some((r) => r.commandKind === "claim_agent_inbox"), false);
  });

  // Hosted via transport: hosted_mcp in directory
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    const edge = makeFakeEdge({ clock, agentRow: { transport: "hosted_mcp" } });
    await assert.rejects(
      () => openCloudLink(baseOptions(profilePath, edge, clock)),
      (err: unknown) => err instanceof CloudLinkError && err.code === "seat_unsupported" && err.seatKind === "hosted",
    );
    assert.equal(edge.requests.some((r) => r.commandKind === "claim_agent_inbox"), false);
  });

  // Link-joined via connect marker in profile directory (zero network calls)
  await withIsolatedProfile({ linkJoinedMarker: true }, async ({ profilePath }) => {
    const clock = new FakeClock();
    const edge = makeFakeEdge({ clock });
    await assert.rejects(
      () => openCloudLink(baseOptions(profilePath, edge, clock)),
      (err: unknown) => err instanceof CloudLinkError && err.code === "seat_unsupported" && err.seatKind === "link_joined",
    );
    assert.equal(edge.requests.length, 0);
  });

  // Turn-only via turn_only: true in directory
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    const edge = makeFakeEdge({ clock, agentRow: { turn_only: true } });
    await assert.rejects(
      () => openCloudLink(baseOptions(profilePath, edge, clock)),
      (err: unknown) => err instanceof CloudLinkError && err.code === "seat_unsupported" && err.seatKind === "turn_only",
    );
    assert.equal(edge.requests.some((r) => r.commandKind === "claim_agent_inbox"), false);
  });
});

test("3. session_not_managed fails with fixed sentence (no ids); session_conflict retries until lapse or seat_busy", async () => {
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    const edge = makeFakeEdge({ clock, acquireErrors: [{ status: 403, error: "session_not_managed" }] });
    await assert.rejects(
      () => openCloudLink(baseOptions(profilePath, edge, clock)),
      (err: unknown) => {
        if (!(err instanceof CloudLinkError) || err.code !== "session_not_managed") return false;
        assert.match(err.message, /owner must enable management/i);
        assert.equal(err.message.includes(WORKSPACE_ID), false);
        assert.equal(err.message.includes(PRINCIPAL_ID), false);
        return true;
      },
    );
  });

  // Recovers when conflict clears within takeoverWaitMs
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    const edge = makeFakeEdge({
      clock,
      generation: 3,
      acquireErrors: [
        { status: 409, error: "session_conflict" },
        { status: 409, error: "session_conflict" },
      ],
    });
    const opening = openCloudLink(baseOptions(profilePath, edge, clock, {
      takeoverWaitMs: 2_000,
      takeoverRetryMs: 400,
    }));
    await waitUntil(() => edge.requests.filter((r) => r.commandKind === "acquire_agent_session").length === 1 && clock.pendingCount() === 1);
    assert.equal(edge.requests.filter((r) => r.commandKind === "acquire_agent_session").length, 1);
    await clock.advance(400);
    await waitUntil(() => edge.requests.filter((r) => r.commandKind === "acquire_agent_session").length === 2 && clock.pendingCount() === 1);
    assert.equal(edge.requests.filter((r) => r.commandKind === "acquire_agent_session").length, 2);
    await clock.advance(400);
    const link = await opening;
    assert.equal(edge.requests.filter((r) => r.commandKind === "acquire_agent_session").length, 3);
    await link.close();
  });

  // Fails with seat_busy when conflict persists past takeoverWaitMs
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    const edge = makeFakeEdge({
      clock,
      acquireErrors: Array.from({ length: 10 }, () => ({ status: 409, error: "session_conflict" })),
    });
    const opening = openCloudLink(baseOptions(profilePath, edge, clock, {
      takeoverWaitMs: 1_000,
      takeoverRetryMs: 400,
    }));
    let settled = false;
    let rejected: unknown = null;
    opening.catch((err) => { rejected = err; settled = true; });
    await waitUntil(() => edge.requests.filter((r) => r.commandKind === "acquire_agent_session").length === 1 && clock.pendingCount() === 1);
    await clock.advance(400);
    await waitUntil(() => edge.requests.filter((r) => r.commandKind === "acquire_agent_session").length === 2 && clock.pendingCount() === 1);
    await clock.advance(400);
    await waitUntil(() => edge.requests.filter((r) => r.commandKind === "acquire_agent_session").length === 3 && clock.pendingCount() === 1);
    await clock.advance(200);
    await waitUntil(() => settled);
    assert.ok(rejected instanceof CloudLinkError && rejected.code === "seat_busy");
  });
});

test("4. claim backs off from pollMinMs doubling to pollMaxMs, resets after delivery, and aborts at once", async () => {
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    const edge = makeFakeEdge({ clock, deliveries: [] });
    const link = await openCloudLink(baseOptions(profilePath, edge, clock, {
      pollMinMs: 100,
      pollMaxMs: 400,
    }));
    try {
      const claimPromise = link.port.claim();
      const claimTimes = () =>
        edge.requests.filter((r) => r.commandKind === "claim_agent_inbox").map((r) => r.atMs);
      await waitUntil(() => claimTimes().length === 1 && clock.pendingCount() === 2);
      const t0 = clock.now();
      assert.deepEqual(claimTimes(), [t0]);

      // Advance over a long idle period: 100 + 200 + 400 * 10 = 4300 ms -> exact schedule, no hot loop
      const expectedTimes = [t0, t0 + 100, t0 + 300];
      for (const [step, count] of [[100, 2], [200, 3]] as const) {
        await clock.advance(step);
        await waitUntil(() => claimTimes().length === count && clock.pendingCount() === 2);
      }
      for (let i = 0; i < 10; i += 1) {
        await clock.advance(400);
        expectedTimes.push(t0 + 300 + 400 * (i + 1));
        await waitUntil(() => claimTimes().length === expectedTimes.length && clock.pendingCount() === 2);
      }
      assert.deepEqual(claimTimes(), expectedTimes);

      // Deliver on the next scheduled poll (+400 ms)
      edge.pushDelivery({
        signalId: "44444444-4444-4444-8444-444444444401",
        leaseId: "55555555-5555-4555-8555-555555555501",
        body: "arrived",
      });
      await clock.advance(400);
      const delivered = await claimPromise;
      assert.equal(delivered?.id, "44444444-4444-4444-8444-444444444401");

      // After delivery, backoff resets to pollMinMs (100 ms)
      const ac = new AbortController();
      const second = link.port.claim(ac.signal);
      const afterDeliveryCount = expectedTimes.length + 2;
      await waitUntil(() => claimTimes().length === afterDeliveryCount && clock.pendingCount() === 2);
      const tAfter = clock.now();
      assert.equal(claimTimes().at(-1), tAfter);
      await clock.advance(100);
      await waitUntil(() => claimTimes().length === afterDeliveryCount + 1 && clock.pendingCount() === 2);
      assert.equal(claimTimes().at(-1), tAfter + 100);

      // Abort mid-wait resolves null at once without another claim
      const countBeforeAbort = claimTimes().length;
      ac.abort();
      assert.equal(await second, null);
      assert.equal(claimTimes().length, countBeforeAbort);
    } finally {
      await link.close();
    }
  });
});

test("5. claim maps thread and private targets and fails on unrecognized delivery shapes", async () => {
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    const threadRoot = "66666666-6666-4666-8666-666666666666";
    const edge = makeFakeEdge({
      clock,
      deliveries: [
        { signalId: "44444444-4444-4444-8444-444444444411", leaseId: "55555555-5555-4555-8555-555555555511", body: "in thread", threadRootId: threadRoot },
        { signalId: "44444444-4444-4444-8444-444444444412", leaseId: "55555555-5555-4555-8555-555555555512", body: "private msg" },
        { signalId: "44444444-4444-4444-8444-444444444413", leaseId: "55555555-5555-4555-8555-555555555513", body: "ignored", kind: "working-on" },
        { signalId: "44444444-4444-4444-8444-444444444414", leaseId: "55555555-5555-4555-8555-555555555514", body: "" },
      ],
    });
    const link = await openCloudLink(baseOptions(profilePath, edge, clock));
    try {
      const m1 = await link.port.claim();
      assert.deepEqual(m1?.replyTarget, { kind: "thread", threadRootId: threadRoot });
      const m2 = await link.port.claim();
      assert.deepEqual(m2?.replyTarget, { kind: "private", inReplyTo: "44444444-4444-4444-8444-444444444412" });
      await assert.rejects(
        () => link.port.claim(),
        (err: unknown) => err instanceof CloudLinkError && err.code === "delivery_unrecognized",
      );
      await assert.rejects(
        () => link.port.claim(),
        (err: unknown) => err instanceof CloudLinkError && err.code === "delivery_unrecognized",
      );
    } finally {
      await link.close();
    }
  });
});

test("6. markSeen sends observed+surfaced+lease; idempotent succeeds; stale-lease & conflict are ordinary failures", async () => {
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    const msgId = "44444444-4444-4444-8444-444444444421";
    const leaseId = "55555555-5555-4555-8555-555555555521";
    let mode: "ok" | "stale" | "conflict" = "ok";
    let authorityLostCalls = 0;
    const edge = makeFakeEdge({
      clock,
      ackHandler: () => {
        if (mode === "stale") return new Response(JSON.stringify({ error: "delivery_unavailable" }), { status: 403 });
        if (mode === "conflict") return new Response(JSON.stringify({ error: "delivery_ack_conflict" }), { status: 409 });
        return null;
      },
    });
    const link = await openCloudLink(baseOptions(profilePath, edge, clock, {
      onAuthorityLost: () => { authorityLostCalls += 1; },
    }));
    try {
      await link.port.markSeen(msgId, leaseId);
      // Idempotent repeat returns accepted 200 -> success
      await link.port.markSeen(msgId, leaseId);
      assert.deepEqual(edge.acked[0], { signalId: msgId, leaseId, outcome: "observed", surfaced: true });

      mode = "stale";
      await assert.rejects(
        () => link.port.markSeen(msgId, leaseId),
        (err: unknown) => err instanceof CloudLinkError && !(err instanceof AuthorityLostError),
      );
      mode = "conflict";
      await assert.rejects(
        () => link.port.markSeen(msgId, leaseId),
        (err: unknown) => err instanceof CloudLinkError && !(err instanceof AuthorityLostError),
      );
      assert.equal(authorityLostCalls, 0);
    } finally {
      await link.close();
    }
  });
});

test("7. postReply sends private with status, thread without, preserves commandId, handles replay and command_id_conflict", async () => {
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    const edge = makeFakeEdge({ clock });
    const link = await openCloudLink(baseOptions(profilePath, edge, clock));
    try {
      const privCmd = {
        commandId: "reply_priv_0001",
        replyTarget: { kind: "private" as const, inReplyTo: "44444444-4444-4444-8444-444444444431" },
        status: "answered" as const,
        body: "private answer",
      };
      await link.port.postReply(privCmd);
      // Identical replay is success
      await link.port.postReply(privCmd);
      assert.equal(edge.posted.length, 1);
      assert.equal(edge.posted[0]!.commandId, "reply_priv_0001");
      assert.equal(edge.posted[0]!.command.in_reply_to, "44444444-4444-4444-8444-444444444431");
      assert.equal(edge.posted[0]!.command.reply_status, "answered");

      // Thread reply sets thread_root_id and NO reply_status
      await link.port.postReply({
        commandId: "reply_thrd_0002",
        replyTarget: { kind: "thread", threadRootId: "66666666-6666-4666-8666-666666666631" },
        body: "thread answer",
      });
      assert.equal(edge.posted[1]!.commandId, "reply_thrd_0002");
      assert.equal(edge.posted[1]!.command.thread_root_id, "66666666-6666-4666-8666-666666666631");
      assert.equal(Object.hasOwn(edge.posted[1]!.command, "reply_status"), false);

      // Same commandId with different content -> command_id_conflict (typed, non-retryable)
      await assert.rejects(
        () => link.port.postReply({ ...privCmd, body: "different body" }),
        (err: unknown) => err instanceof CloudLinkError && err.code === "command_id_conflict" && err.retryable === false,
      );
    } finally {
      await link.close();
    }
  });
});

test("8. proof refusal on claim, markSeen, and postReply becomes AuthorityLostError, notifies once, zero requests after", async () => {
  const cases = [
    { op: "claim" as const, status: 401, code: "session_expired" },
    { op: "markSeen" as const, status: 409, code: "session_conflict" },
    { op: "postReply" as const, status: 401, code: "session_proof_invalid" },
  ];
  for (const c of cases) {
    await withIsolatedProfile({}, async ({ profilePath }) => {
      const clock = new FakeClock();
      let lostCount = 0;
      const refuse = () => new Response(JSON.stringify({ error: c.code }), { status: c.status });
      const edge = makeFakeEdge({
        clock,
        claimHandler: c.op === "claim" ? refuse : undefined,
        ackHandler: c.op === "markSeen" ? refuse : undefined,
        postHandler: c.op === "postReply" ? refuse : undefined,
      });
      const link = await openCloudLink(baseOptions(profilePath, edge, clock, {
        onAuthorityLost: () => { lostCount += 1; },
      }));
      const msgId = "44444444-4444-4444-8444-444444444441";
      const leaseId = "55555555-5555-4555-8555-555555555541";
      const replyCmd = {
        commandId: "reply_auth_0001",
        replyTarget: { kind: "private" as const, inReplyTo: msgId },
        status: "answered" as const,
        body: "hi",
      };
      if (c.op === "claim") await assert.rejects(() => link.port.claim(), AuthorityLostError);
      if (c.op === "markSeen") await assert.rejects(() => link.port.markSeen(msgId, leaseId), AuthorityLostError);
      if (c.op === "postReply") await assert.rejects(() => link.port.postReply(replyCmd), AuthorityLostError);

      assert.equal(lostCount, 1);
      const countAtLoss = edge.requests.length;
      await assert.rejects(() => link.port.claim(), AuthorityLostError);
      await assert.rejects(() => link.port.markSeen(msgId, leaseId), AuthorityLostError);
      await assert.rejects(() => link.port.postReply(replyCmd), AuthorityLostError);
      await link.close();
      assert.equal(lostCount, 1);
      assert.equal(edge.requests.length, countAtLoss, `zero requests allowed after proof refusal on ${c.op}`);
    });
  }
});

test("9. session manager renew failure triggers onAuthorityLost and blocks all subsequent requests", async () => {
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    let lostCount = 0;
    const edge = makeFakeEdge({
      clock,
      renewHandler: () => new Response(JSON.stringify({ error: "session_expired" }), { status: 401 }),
    });
    const link = await openCloudLink(baseOptions(profilePath, edge, clock, {
      onAuthorityLost: () => { lostCount += 1; },
    }));
    await clock.advance(AGENT_SESSION_RENEW_AFTER_MS);
    await waitUntil(() => lostCount === 1);
    assert.equal(lostCount, 1);
    const countAfterRenew = edge.requests.length;
    await assert.rejects(() => link.port.claim(), AuthorityLostError);
    await assert.rejects(
      () => link.port.markSeen("44444444-4444-4444-8444-444444444451", "55555555-5555-4555-8555-555555555551"),
      AuthorityLostError,
    );
    await assert.rejects(
      () => link.port.postReply({
        commandId: "reply_renew_0001",
        replyTarget: { kind: "private", inReplyTo: "44444444-4444-4444-8444-444444444451" },
        status: "answered",
        body: "nope",
      }),
      AuthorityLostError,
    );
    assert.equal(edge.requests.length, countAfterRenew);
    await link.close();
  });
});

test("10. close releases session once and never throws even when release fails", async () => {
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    const edge = makeFakeEdge({
      clock,
      releaseHandler: () => new Response(JSON.stringify({ error: "internal_error" }), { status: 500 }),
    });
    const link = await openCloudLink(baseOptions(profilePath, edge, clock));
    await link.close();
    await link.close();
    assert.equal(edge.requests.filter((r) => r.commandKind === "release_agent_session").length, 1);
    assert.equal(clock.pendingCount(), 0);
  });
});

test("11. no recorded request metadata or thrown error leaks bearer, session key, message body or reply body", async () => {
  await withIsolatedProfile({}, async ({ profilePath }) => {
    const clock = new FakeClock();
    const msgId = "44444444-4444-4444-8444-444444444461";
    const leaseId = "55555555-5555-4555-8555-555555555561";
    let failPost = false;
    const edge = makeFakeEdge({
      clock,
      deliveries: [
        { signalId: msgId, leaseId, body: MESSAGE_SECRET_BODY },
        { signalId: "44444444-4444-4444-8444-444444444462", leaseId: "55555555-5555-4555-8555-555555555562", body: MESSAGE_SECRET_BODY, kind: "working-on" },
      ],
      ackHandler: () => new Response(JSON.stringify({ error: "delivery_unavailable", detail: MESSAGE_SECRET_BODY }), { status: 403 }),
      postHandler: () => failPost
        ? new Response(JSON.stringify({ error: "invalid_request", message: `${REPLY_SECRET_BODY} ${BEARER}` }), { status: 400 })
        : null,
    });
    const link = await openCloudLink(baseOptions(profilePath, edge, clock));
    const collectedErrors: string[] = [];
    const msg = await link.port.claim();
    assert.equal(msg?.text, MESSAGE_SECRET_BODY);
    await link.port.claim().catch((e) => collectedErrors.push(String(e)));
    await link.port.markSeen(msgId, leaseId).catch((e) => collectedErrors.push(String(e)));
    failPost = true;
    await link.port.postReply({
      commandId: "reply_leak_0001",
      replyTarget: { kind: "private", inReplyTo: msgId },
      status: "answered",
      body: REPLY_SECRET_BODY,
    }).catch((e) => collectedErrors.push(String(e)));
    await link.close();

    assert.ok(collectedErrors.length >= 3);
    const haystack = JSON.stringify({ requests: edge.requests, errors: collectedErrors });
    for (const secret of [BEARER, NEXT_BEARER, MESSAGE_SECRET_BODY, REPLY_SECRET_BODY, ...edge.observedSessionKeys]) {
      assert.equal(haystack.includes(secret), false, `leaked sensitive value of length ${secret.length}`);
    }
  });
});

test("12. real EngineRunner + openCloudLink + fake edge + stand-in harness processes 3 deliveries in order", async () => {
  await withIsolatedProfile({}, async ({ root, profilePath }) => {
    const clock = new FakeClock();
    const threadRoot = "66666666-6666-4666-8666-666666666677";
    const deliveries: FakeDelivery[] = [
      { signalId: "44444444-4444-4444-8444-444444444471", leaseId: "55555555-5555-4555-8555-555555555571", body: "first" },
      { signalId: "44444444-4444-4444-8444-444444444472", leaseId: "55555555-5555-4555-8555-555555555572", body: "second", threadRootId: threadRoot },
      { signalId: "44444444-4444-4444-8444-444444444473", leaseId: "55555555-5555-4555-8555-555555555573", body: "third" },
    ];
    let resolveAllPosted!: () => void;
    const allPosted = new Promise<void>((resolve) => { resolveAllPosted = resolve; });
    const edge = makeFakeEdge({
      clock,
      deliveries,
      onPostAccepted(count) { if (count >= 3) resolveAllPosted(); },
    });
    let runner: EngineRunner | null = null;
    const link = await openCloudLink(baseOptions(profilePath, edge, clock, {
      onAuthorityLost: () => runner?.loseAuthority(),
    }));
    const prompts: string[] = [];
    const harness: HarnessPort = {
      async runTurn(text: string): Promise<string> {
        prompts.push(text);
        return `reply:${text}`;
      },
      interrupt() {},
    };
    const journalPath = join(root, "journal.ndjson");
    runner = new EngineRunner({
      journalPath,
      harness,
      cloud: link.port,
      clock,
      replyRetryHorizonMs: 3_600_000,
      compactAfterRecords: 50,
      settledIdCap: 100,
    });
    await runner.start();
    await allPosted;
    const result = await runner.stop();
    await link.close();

    assert.equal(result.reason, "stopped");
    assert.deepEqual(prompts, ["first", "second", "third"]);
    assert.equal(edge.acked.length, 3);
    assert.deepEqual(
      edge.acked.map((a) => [a.signalId, a.leaseId, a.outcome, a.surfaced]),
      deliveries.map((d) => [d.signalId, d.leaseId, "observed", true]),
    );
    assert.equal(edge.posted.length, 3);
    assert.deepEqual(
      edge.posted.map((p) => p.command.body),
      ["reply:first", "reply:second", "reply:third"],
    );
    assert.equal(edge.posted[0]!.command.in_reply_to, deliveries[0]!.signalId);
    assert.equal(edge.posted[0]!.command.reply_status, "answered");
    assert.equal(edge.posted[1]!.command.thread_root_id, threadRoot);
    assert.equal(Object.hasOwn(edge.posted[1]!.command, "reply_status"), false);
    assert.equal(edge.posted[2]!.command.in_reply_to, deliveries[2]!.signalId);
    assert.equal(edge.posted[2]!.command.reply_status, "answered");
  });
});

/**
 * Pure client contract for agent-receive MVP: typed recipient resolution,
 * wait deadlines, JSON shapes, timeout/error separation, and the resilient
 * inbox --follow --ndjson receive stream.
 *
 * ★ THIS FILE IS NAMED IN `npm test` — a hand-run or typecheck-only pass is not a gate.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  listenerPaths,
  runListenerSupervisor,
  type ListenerRuntimeEvent,
} from "../../src/listener/index.js";
import {
  followHttpDetails,
  isFollowCredentialFailure,
  isRestartableReadError,
  isRetryableFollowError,
  parseSignalRecord,
  readAgentSignalPage,
  readSignals,
  renderSignals,
  resolveSignalRecipient,
  runInboxFollow,
  SIGNAL_FOLLOW_PAGE_LIMIT,
  SignalHttpError,
  LocalCredentialSecretAbsentError,
  type FollowArmRequest,
  type FollowFrame,
  type SignalDirectory,
} from "../../src/cloud/signals.js";
import {
  describeServerError,
  parseServerErrorEnvelope,
  serverRefusedRetry,
} from "../../src/cloud/error-envelope.js";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";
const USER_B = "44444444-4444-4444-8444-444444444444";
const AGENT = "22222222-2222-4222-8222-222222222222";
const AGENT_B = "55555555-5555-4555-8555-555555555555";
const SIGNAL = "33333333-3333-4333-8333-333333333333";

const directory: SignalDirectory = {
  members: [
    { user_id: USER, display_name: "Quill" },
    { user_id: USER_B, display_name: "Shared" },
  ],
  agents: [
    { principal_id: AGENT, name: "Hermes" },
    { principal_id: AGENT_B, name: "Shared" },
  ],
};

function row(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: SIGNAL,
    workspace_id: WORKSPACE,
    from: AGENT,
    from_kind: "agent",
    to: null,
    to_agent: null,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body: "mvp-ping",
    until: "2026-07-25T00:00:00.000Z",
    created_at: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

test("typed recipient resolution prefers exact UUID and unique name across members and agents", () => {
  assert.deepEqual(resolveSignalRecipient(USER, directory), {
    kind: "user",
    id: USER,
  });
  assert.deepEqual(resolveSignalRecipient(AGENT, directory), {
    kind: "agent",
    id: AGENT,
  });
  assert.deepEqual(resolveSignalRecipient("Hermes", directory), {
    kind: "agent",
    id: AGENT,
  });
  assert.deepEqual(resolveSignalRecipient("Quill", directory), {
    kind: "user",
    id: USER,
  });
  assert.throws(
    () => resolveSignalRecipient("Shared", directory),
    /ambiguous; use one of these ids: user 44444444.*agent 55555555/,
  );
  assert.throws(
    () => resolveSignalRecipient("Nobody", directory),
    /not a live member or agent/,
  );
  assert.throws(
    () =>
      resolveSignalRecipient("77777777-7777-4777-8777-777777777777", directory),
    /not a live member or agent/,
  );
});

// ---------------------------------------------------------------------------
// inbox --follow --ndjson resilient receive stream
// ---------------------------------------------------------------------------

test("follow secret/credential absence never emits ready", async () => {
  const frames: FollowFrame[] = [];
  const secretMissing = new LocalCredentialSecretAbsentError();
  assert.equal(isFollowCredentialFailure(secretMissing), true);
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    sleep: async () => {
      throw new Error("sleep must not run when secret is absent");
    },
    arm: async () => {
      throw secretMissing;
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "credential");
  assert.equal(stop.error, secretMissing);
  // No ready, and the terminal frame carries no server detail because this
  // failure never crossed the network.
  assert.deepEqual(frames.map((f) => f.type), ["error"]);
  const terminal = frames[0];
  assert.ok(terminal?.type === "error");
  assert.equal(terminal.reason, "credential");
  assert.equal(terminal.server_refused, false);
  assert.equal(terminal.request_id, null);
});

test("follow classifies a confirmed credential code as a stop and retries a bare 403", async () => {
  for (const [status, code] of [
    [401, "unauthenticated"],
    [403, "forbidden"],
  ] as const) {
    const refusal = new SignalHttpError(status, null, {
      error: code,
      requestId: null,
      retryable: null,
    });
    assert.equal(isFollowCredentialFailure(refusal), true);
    const stop = await runInboxFollow({
      workspaceId: WORKSPACE,
      now: () => 1_700_000_000_000,
      sleep: async () => {
        throw new Error("sleep must not run after credential refusal");
      },
      arm: async () => {
        throw refusal;
      },
      emit: (frame) => {
        // The terminal error frame is expected; a ready frame is not.
        if (frame.type !== "error") {
          throw new Error("credential refusal must not emit ready");
        }
      },
    });
    assert.equal(stop.reason, "credential");
    assert.equal(stop.error, refusal);
  }

  const controller = new AbortController();
  let arms = 0;
  let sleeps = 0;
  const bare = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => 1_700_000_000_000,
    random: () => 0,
    signal: controller.signal,
    sleep: async () => {
      sleeps += 1;
      if (sleeps >= 2) controller.abort();
    },
    arm: async () => {
      arms += 1;
      throw new SignalHttpError(403);
    },
    emit: () => undefined,
  });
  assert.notEqual(bare.reason, "credential");
  assert.equal(bare.reason, "cancelled");
  assert.equal(arms, 2);
});

test("agent signal pages expose capabilities and fail closed on absent markers", async () => {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      signals: [{ ...row(), sender_owner_relation: "same_owner" }],
      capabilities: { sender_owner_relation: 1, cursor_after: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const page = await readAgentSignalPage(
    target,
    { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
    {
      workspaceId: WORKSPACE,
      inbox: true,
      kind: "ask",
      ascending: true,
      limit: 100,
    },
    { fetcher },
  );
  assert.deepEqual(page.capabilities, {
    senderOwnerRelation: true,
    cursorAfter: true,
    deliveryClaim: false,
    deliveryAck: false,
  });
  assert.equal(page.legacyCursorFallback, false);
  assert.equal(bodies[0]?.after_created_at, null);
  assert.equal(bodies[0]?.after_id, null);
  assert.equal(page.signals[0]?.sender_owner_relation, "same_owner");

  const old = await readAgentSignalPage(
    target,
    { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
    { workspaceId: WORKSPACE, inbox: true },
    {
      fetcher: (async () =>
        new Response(JSON.stringify({ signals: [row()] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    },
  );
  assert.deepEqual(old.capabilities, {
    senderOwnerRelation: false,
    cursorAfter: false,
    deliveryClaim: false,
    deliveryAck: false,
  });
  assert.equal(old.signals[0]?.sender_owner_relation, "unknown");
});

test("legacy cursor fallback is explicit and a capable 400 still fails", async () => {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const requests: Array<Record<string, unknown>> = [];
  const legacyFetcher = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (Object.hasOwn(body, "after_created_at")) {
      return new Response("{}", { status: 400 });
    }
    return new Response(JSON.stringify({ signals: [row()] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const page = await readAgentSignalPage(
    target,
    { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
    {
      workspaceId: WORKSPACE,
      inbox: true,
      ascending: true,
      limit: 100,
    },
    { fetcher: legacyFetcher },
    { allowLegacyCursorFallback: true },
  );
  assert.equal(page.legacyCursorFallback, true);
  assert.equal(requests.length, 2);
  assert.equal(Object.hasOwn(requests[1]!, "after_created_at"), false);

  await assert.rejects(
    readAgentSignalPage(
      target,
      { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
      {
        workspaceId: WORKSPACE,
        inbox: true,
        ascending: true,
        limit: 100,
      },
      {
        fetcher: (async (
          _url: string | URL | Request,
          init?: RequestInit,
        ) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Object.hasOwn(body, "after_created_at")
            ? new Response("{}", { status: 400 })
            : new Response(JSON.stringify({
              signals: [],
              capabilities: { sender_owner_relation: 1, cursor_after: 1 },
            }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
        }) as typeof fetch,
      },
      { allowLegacyCursorFallback: true },
    ),
    /HTTP 400/,
  );
});

test("follow-only row quarantine is bounded and preserves a raw page cursor", async () => {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const malformed = { ...row(), body: "" };
  const last = row({
    id: "13111111-1111-4111-8111-111111111111",
    created_at: "2026-07-24T00:00:02.000Z",
  });
  const response = () =>
    new Response(JSON.stringify({
      signals: [malformed, last],
      capabilities: { sender_owner_relation: 1, cursor_after: 1 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  await assert.rejects(
    readAgentSignalPage(
      target,
      { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
      { workspaceId: WORKSPACE, inbox: true, ascending: true },
      { fetcher: (async () => response()) as typeof fetch },
    ),
    /malformed signal data/,
  );

  const diagnostics: number[] = [];
  const page = await readAgentSignalPage(
    target,
    { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
    { workspaceId: WORKSPACE, inbox: true, ascending: true },
    { fetcher: (async () => response()) as typeof fetch },
    {
      tolerateMalformedRows: true,
      maxMalformedRows: 1,
      onMalformedRow: (index) => diagnostics.push(index),
    },
  );
  assert.equal(page.rawCount, 2);
  assert.equal(page.malformedRows, 1);
  assert.deepEqual(diagnostics, [0]);
  assert.deepEqual(page.signals.map((item) => item.id), [last.id]);
  assert.deepEqual(page.nextCursor, {
    created_at: last.created_at,
    id: last.id,
  });

  await assert.rejects(
    readAgentSignalPage(
      target,
      { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
      { workspaceId: WORKSPACE, inbox: true, ascending: true },
      {
        fetcher: (async () =>
          new Response(JSON.stringify({
            signals: [malformed, malformed],
            capabilities: { sender_owner_relation: 1, cursor_after: 1 },
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      },
      { tolerateMalformedRows: true, maxMalformedRows: 1 },
    ),
    /too many malformed rows/,
  );
});

test("follow refuses a full quarantined page without a safe terminal cursor", async () => {
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    pageLimit: 1,
    sleep: async () => {},
    arm: async () => ({
      signals: [],
      rawCount: 1,
      nextCursor: null,
      canPage: true,
    }),
    emit: () => undefined,
  });
  assert.equal(stop.reason, "malformed");
  assert.match(stop.error?.message ?? "", /terminal cursor is malformed/);
});

// ---------------------------------------------------------------------------
// Lossless follow cursor, tolerant parse, honest renewal copy
// ---------------------------------------------------------------------------

test("parseSignalRecord ignores unknown fields and fails closed on bad required data", () => {
  const base = row();
  const parsed = parseSignalRecord({
    ...base,
    future_enum: "whatever",
    extra_nested: { a: 1 },
  });
  assert.equal(parsed.id, base.id);
  assert.equal(parsed.body, base.body);
  // Absent relation from an older edge is fail-closed to unknown for wake.
  assert.equal(parsed.sender_owner_relation, "unknown");
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed, "future_enum"),
    false,
  );

  // Absent optional fields from an older edge normalize to null / unknown.
  const legacy = parseSignalRecord({
    id: base.id,
    workspace_id: base.workspace_id,
    from: base.from,
    from_kind: base.from_kind,
    to: null,
    about: null,
    kind: "note",
    body: "hello",
    until: base.until,
    created_at: base.created_at,
  });
  assert.equal(legacy.to_agent, null);
  assert.equal(legacy.in_reply_to, null);
  assert.equal(legacy.sender_owner_relation, "unknown");

  const related = parseSignalRecord({
    ...base,
    sender_owner_relation: "same_owner",
  });
  assert.equal(related.sender_owner_relation, "same_owner");

  // Present-but-invalid optional UUID fails closed.
  assert.throws(
    () => parseSignalRecord({ ...base, to_agent: "not-a-uuid" }),
    /malformed to_agent/,
  );
  // Present-but-invalid relation enum fails closed (not coerced to unknown).
  assert.throws(
    () => parseSignalRecord({ ...base, sender_owner_relation: "sibling" }),
    /malformed sender_owner_relation/,
  );
  // Unknown kind fails closed (not silently coerced).
  assert.throws(
    () => parseSignalRecord({ ...base, kind: "redirect" }),
    /malformed signal data/,
  );
});

test("read parsing accepts newer server string bounds but still rejects structural damage", () => {
  const base = row();
  const longBody = "b".repeat(8_001);
  const longAbout = "a".repeat(501);
  const parsed = parseSignalRecord({
    ...base,
    body: longBody,
    about: longAbout,
  });
  assert.equal(parsed.body, longBody);
  assert.equal(parsed.about, longAbout);

  /* Each row pins WHY it is refused, not merely THAT it is. The original passed
   * `undefined` as the predicate: that is not a valid AssertPredicate, so it failed
   * `check:tests` — the only script that typechecks this directory — and it also
   * asserted nothing about the reason, so a row refused for the wrong cause passed
   * silently. Tightening it immediately surfaced that a bad id reports a DISTINCT,
   * more specific error than the generic one, which the loose form had hidden. */
  const malformedRows = [
    { name: "missing id", value: { ...base, id: undefined }, expect: /malformed id/ },
    { name: "non-string body", value: { ...base, body: 42 }, expect: /malformed signal data/ },
    { name: "bad UUID", value: { ...base, id: "not-a-uuid" }, expect: /malformed id/ },
    {
      name: "bad created_at",
      value: { ...base, created_at: "not-a-time" },
      expect: /malformed created_at/,
    },
  ];
  for (const malformed of malformedRows) {
    assert.throws(
      () => parseSignalRecord(malformed.value),
      malformed.expect,
      malformed.name,
    );
  }
});

test("human rendering bounds forward-compatible strings and reports original lengths", () => {
  const body = "b".repeat(100_000);
  const about = "a".repeat(10_000);
  const parsed = parseSignalRecord({ ...row(), body, about });
  const rendered = renderSignals([parsed], {
    inbox: false,
    includeStale: true,
  });

  assert.equal(parsed.body.length, 100_000);
  assert.equal(parsed.about?.length, 10_000);
  assert.ok(rendered.length < 10_000, `render grew to ${rendered.length} characters`);
  assert.match(
    rendered,
    /WARNING: Body clipped for display\. Showing 8000 of 100000 characters\. Use --json to read the full body\./,
  );
  assert.match(
    rendered,
    /WARNING: About reference clipped for display\. Showing 500 of 10000 characters\. Use --json to read the full reference\./,
  );
});

test("follow pages a backlog larger than one page without dropping older rows", async () => {
  assert.equal(SIGNAL_FOLLOW_PAGE_LIMIT, 100);
  const page1 = [
    row({
      id: "11111111-1111-4111-8111-111111111101",
      created_at: "2026-07-24T00:00:01.000Z",
      body: "old-1",
    }),
    row({
      id: "11111111-1111-4111-8111-111111111102",
      created_at: "2026-07-24T00:00:02.000Z",
      body: "old-2",
    }),
  ];
  const page2 = [
    row({
      id: "11111111-1111-4111-8111-111111111103",
      created_at: "2026-07-24T00:00:03.000Z",
      body: "new-3",
    }),
  ];
  const frames: FollowFrame[] = [];
  const requests: FollowArmRequest[] = [];
  const controller = new AbortController();
  let arms = 0;
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    pageLimit: 2,
    now: () => 1_700_000_000_000,
    random: () => 0,
    sleep: async () => {
      // Cancel once the idle poll would run (backlog drained).
      if (arms >= 3) controller.abort();
    },
    signal: controller.signal,
    arm: async (page) => {
      requests.push(page);
      arms += 1;
      if (arms === 1) {
        assert.equal(page.after, null);
        assert.equal(page.limit, 2);
        return page1;
      }
      if (arms === 2) {
        assert.deepEqual(page.after, {
          created_at: "2026-07-24T00:00:02.000Z",
          id: "11111111-1111-4111-8111-111111111102",
        });
        return page2;
      }
      // Idle rearm after drain.
      assert.equal(page.after, null);
      return [];
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "cancelled");
  assert.equal(frames[0]?.type, "ready");
  const bodies = frames
    .filter((f): f is Extract<FollowFrame, { type: "signal" }> =>
      f.type === "signal"
    )
    .map((f) => f.signal.body);
  assert.deepEqual(bodies, ["old-1", "old-2", "new-3"]);
  assert.ok(requests.length >= 3, "expected catch-up pages then idle rearm");
});

test("follow resets the page cursor after each scan so late older rows arrive", async () => {
  const frames: FollowFrame[] = [];
  const cursors: Array<FollowArmRequest["after"]> = [];
  const controller = new AbortController();
  const first = row({
    id: "12111111-1111-4111-8111-111111111111",
    created_at: "2026-07-24T00:00:10.000Z",
    body: "first",
  });
  const lateOlder = row({
    id: "12111111-1111-4111-8111-111111111112",
    created_at: "2026-07-24T00:00:05.000Z",
    body: "late-older",
  });
  let arm = 0;
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    pageLimit: 100,
    pollMs: 1,
    postEmitMs: 1,
    signal: controller.signal,
    sleep: async () => {},
    arm: async ({ after }) => {
      cursors.push(after);
      arm += 1;
      if (arm === 1) return [first];
      if (arm === 2) return [lateOlder, first];
      controller.abort();
      return [];
    },
    emit: (frame) => frames.push(frame),
  });
  assert.equal(stop.reason, "cancelled");
  assert.deepEqual(cursors.slice(0, 2), [null, null]);
  assert.deepEqual(
    frames.filter((frame) => frame.type === "signal")
      .map((frame) => frame.type === "signal" ? frame.signal.body : ""),
    ["first", "late-older"],
  );
});

test("unrecognized supervisor runtime events never become delivery ACKs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-supervisor-unknown-event-"));
  const workspaceId = randomUUID();
  const principalId = randomUUID();
  const paths = listenerPaths({
    profileId: "profile-unknown-event",
    workspaceId,
    principalId,
    stateDirectory: root,
  });
  const ts = "2026-08-03T00:00:00.000Z";

  try {
    const status = await runListenerSupervisor({
      paths,
      profileId: "profile-unknown-event",
      workspaceId,
      principalId,
      run: async (_signal, onEvent) => {
        onEvent({
          type: "future_delivery_event",
          signalId: randomUUID(),
          outcome: "replied",
          ts,
        } as unknown as ListenerRuntimeEvent);
        return { reason: "cancelled" };
      },
    });
    assert.equal(status.lastAckAt, null);
    assert.equal(status.lastSignalId, null);
    const log = await readFile(paths.logPath, "utf8");
    assert.doesNotMatch(log, /listener_delivery_ack/);
    assert.match(log, /listener_malformed_event/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D-051: the client amplified a production saturation event by retrying
// failures the server had explicitly refused. Every error body carries
// {error, request_id, retryable}; the read path touched only .status, so
// `retryable: false` was discarded and each rejection became another request.
// ---------------------------------------------------------------------------

const D051_REQUEST_ID = "9d1f4b2c-0000-4000-8000-abcdefabcdef";

function d051Body(retryable: boolean | null): string {
  return JSON.stringify({
    error: "internal_error",
    request_id: D051_REQUEST_ID,
    ...(retryable === null ? {} : { retryable }),
  });
}

/**
 * One follow run: the first read succeeds (so the stream is ready and a
 * `retrying` frame is observable at all), every later read fails with the same
 * stubbed 500 whose body differs ONLY in `retryable`. Counts requests, because
 * requests are the thing that fed the saturation.
 */
async function d051FollowRun(
  errorBody: string,
  // D-056 added BOUNDED tolerance for server refusals, which changes how many
  // times a refused loop fetches. These D-051 cases assert the VETO itself --
  // that a refusal is not retried immediately and is distinguishable from a
  // permitted retry -- so they pin tolerance to 0 and keep testing exactly what
  // they were written to test. The tolerance has its own cases below.
  refusalToleranceMs = 0,
  // Default 4 preserves the bound the D-051 cases were written against; only the
  // tolerance cases, which legitimately make more requests, raise it.
  maxFetches = 4,
  // Outcomes for reads AFTER the first (which always succeeds so the stream
  // reaches ready). Default: refuse everything, the consecutive-burst shape.
  // Verity's adversarial case needs the ISOLATED shape -- a success between every
  // refusal -- which no existing case could express, and which is exactly where a
  // lifetime budget and a per-burst budget diverge.
  outcomes: readonly boolean[] | null = null,
): Promise<{
  fetches: number;
  retryFrames: number;
  frames: FollowFrame[];
  stop: Awaited<ReturnType<typeof runInboxFollow>>;
}> {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const frames: FollowFrame[] = [];
  const controller = new AbortController();
  let fetches = 0;
  const fetcher = (async () => {
    fetches += 1;
    const scripted = outcomes === null ? false : (outcomes[fetches - 2] ?? false);
    if (fetches === 1 || scripted) {
      return new Response(
        JSON.stringify({
          signals: fetches === 1 ? [row()] : [],
          capabilities: { sender_owner_relation: 1, cursor_after: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(errorBody, {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  // The clock must ADVANCE. The refusal budget is a time window, so a frozen
  // clock would make it inexhaustible and every tolerance case would measure the
  // harness bound instead of the budget. Sleeping advances it by exactly the
  // delay the code asked for, which is what a real clock would do.
  let clockMs = 1_700_000_000_000;
  const stop = await runInboxFollow({
    workspaceId: WORKSPACE,
    now: () => clockMs,
    random: () => 0,
    pollMs: 0,
    postEmitMs: 0,
    refusalToleranceMs,
    // Bounds a retrying arm so the loop cannot spin forever.
    // ~~"A refusing arm never reaches a retry sleep, so this hook cannot mask
    // its behaviour."~~ DEAD as of D-056: a TOLERATED refusal now does reach the
    // sleep. Any case asserting that the CODE stopped must assert
    // stop.reason === "error" -- "cancelled" means this harness stopped the loop,
    // not the logic under test.
    sleep: async (ms: number) => {
      clockMs += ms;
      if (fetches >= maxFetches) controller.abort();
    },
    signal: controller.signal,
    arm: async () =>
      await readSignals(
        target,
        { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
        { workspaceId: WORKSPACE, inbox: true },
        { fetcher },
      ),
    emit: (frame) => frames.push(frame),
  });
  return {
    fetches,
    retryFrames: frames.filter((frame) => frame.type === "retrying").length,
    frames,
    stop,
  };
}

test("D-051: envelope parsing is total and cannot be steered by a body", () => {
  for (
    const body of [
      null,
      undefined,
      "string",
      42,
      [],
      [{ retryable: false }],
      {},
      { retryable: "false" },
      { retryable: 0 },
      { error: 7, request_id: {} },
    ]
  ) {
    const envelope = parseServerErrorEnvelope(body);
    assert.equal(envelope.retryable, null, JSON.stringify(body ?? null));
    assert.equal(serverRefusedRetry(envelope), false);
  }
  assert.equal(parseServerErrorEnvelope({ retryable: false }).retryable, false);
  assert.equal(parseServerErrorEnvelope({ retryable: true }).retryable, true);

  // Both fields are machine tokens. Free-form prose is dropped, so a body
  // cannot inject text into a message this client's own classifiers match on.
  const hostile = parseServerErrorEnvelope({
    error: "secret is absent",
    request_id: "id with spaces",
    retryable: false,
  });
  assert.equal(hostile.error, null);
  assert.equal(hostile.requestId, null);
  assert.equal(hostile.retryable, false);
  assert.equal(describeServerError("signal read failed (HTTP 500)", hostile), "signal read failed (HTTP 500)");
  // Positive control on the same shape: a real token IS carried through.
  assert.equal(
    describeServerError(
      "signal read failed (HTTP 500)",
      parseServerErrorEnvelope({ error: "internal_error", retryable: false }),
    ),
    "signal read failed (HTTP 500): internal_error",
  );
});

test("D-051: a hostile error body cannot forge a credential failure", async () => {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  const read = async (body: string): Promise<Error> => {
    const fetcher = (async () =>
      new Response(body, { status: 500 })) as typeof fetch;
    try {
      await readSignals(
        target,
        { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
        { workspaceId: WORKSPACE, inbox: true },
        { fetcher },
      );
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected the stubbed 500 to reject");
  };

  const forged = await read(
    JSON.stringify({ error: "secret is absent", retryable: false }),
  );
  assert.equal(isFollowCredentialFailure(forged), false);
  assert.doesNotMatch(forged.message, /secret is absent/);

  // Only the locally owned error type can classify a missing secret.
  assert.equal(
    isFollowCredentialFailure(new LocalCredentialSecretAbsentError()),
    true,
  );
  assert.equal(isFollowCredentialFailure(new Error("the agent secret is absent")), false);
});

// ---------------------------------------------------------------------------
// D-051 companion 1: the backoff attempt counter decays on success instead of
// resetting to zero. Zeroing was the amplifier's engine — an intermittently
// failing receiver climbed, succeeded, reset, and climbed again, so it never
// reached the 30s cap. 13.2 retry frames/min observed against ~2/min at cap.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// D-051 companion 3: cancellation is a fact about our own AbortSignal, never
// about wording. Parsing failure bodies made the old `/aborted/i` message
// regex reachable from outside — a server answering {"error":"aborted"} would
// have been read as a clean operator cancel, so a receiver would exit quietly
// reporting success while having read nothing.
// ---------------------------------------------------------------------------

test("D-051: an error body saying 'aborted' cannot forge a cancellation", async () => {
  // 'aborted' is slug-shaped, so the contract-shape filter passes it through
  // to the message. Type, not text, is what must decide.
  const inAnyField = [
    { error: "aborted", request_id: "9d1f4b2c-0000-4000-8000-abcdefabcdef" },
    { error: "internal_error", request_id: "aborted-9d1f4b2c" },
    { error: "aborted", request_id: "aborted" },
  ];
  for (const envelope of inAnyField) {
    const run = await d051FollowRun(
      JSON.stringify({ ...envelope, retryable: false }),
    );
    assert.equal(
      run.stop.reason,
      "error",
      `must not be cancelled: ${JSON.stringify(envelope)}`,
    );
    assert.notEqual(run.stop.reason, "cancelled");
    // It is surfaced as a failure with the server's own words intact.
    assert.match(String(run.stop.error?.message), /HTTP 500/);
  }

  // Positive control on the same harness: a real caller abort IS a
  // cancellation, so this is not passing because nothing can cancel.
  const cancelled = await d051FollowRun(d051Body(true));
  assert.equal(cancelled.stop.reason, "cancelled");
});

test("D-051: a credential verdict off the wire is decided by status, not wording", () => {
  // Locally-thrown secret absence classifies only by type.
  assert.equal(
    isFollowCredentialFailure(new LocalCredentialSecretAbsentError()),
    true,
  );
  assert.equal(isFollowCredentialFailure(new SignalHttpError(401)), false);
  assert.equal(isFollowCredentialFailure(new SignalHttpError(403)), false);
  assert.equal(
    isFollowCredentialFailure(new SignalHttpError(401, null, {
      error: "unauthenticated",
      requestId: null,
      retryable: null,
    })),
    true,
  );
  assert.equal(
    isFollowCredentialFailure(new SignalHttpError(403, null, {
      error: "forbidden",
      requestId: null,
      retryable: null,
    })),
    true,
  );

  // A wire error carrying the phrase must not be promoted to a credential
  // stop by its text. Status is the only vote it gets.
  const wire = new SignalHttpError(500, null, {
    error: "secret_is_absent",
    requestId: null,
    retryable: false,
  });
  assert.equal(isFollowCredentialFailure(wire), false);
  assert.match(wire.message, /secret_is_absent/);
});

// ---------------------------------------------------------------------------
// D-055: --ndjson is for machine consumption and the connect prompt points
// non-Grok hosts at it, so a fatal stop written as bare text made the stream's
// LAST word the one line a wrapper cannot parse — exactly when it most needs
// to read it. The information was already there; the encoding was wrong.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// D-058: classification is by identity, never by wording. followHttpDetails
// used to fall back to a message regex and isTransportFollowMessage matched
// exact prose, so an unrecognised error type spelled like one of ours acquired
// a status — and through the restart classifier, a restart it had not earned.
// This is D-053 (control flow on untrusted text) surviving inside the D-057
// closed classification.
//
// The regex is gone. These are the POSITIVE CONTROLS that the real, tagged
// paths still classify — deleting a fallback is only safe if the primary works.
// ---------------------------------------------------------------------------

async function readFailure(
  fetcher: typeof fetch,
): Promise<Error> {
  const target = cloudTarget("https://cloud.example.test", "anon-key");
  try {
    await readSignals(
      target,
      { kind: "agent", token: "swm_agt_" + "A".repeat(43) },
      { workspaceId: WORKSPACE, inbox: true },
      { fetcher },
    );
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the stubbed read to reject");
}

test("D-058: an impostor spelled exactly like ours gets no verdict", async () => {
  // The same two spellings, on an error this module did not construct. Before
  // the fix both were classified; the message is identical to the real one.
  const real = await readFailure((async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  const impostor = new Error(real.message);
  assert.equal(impostor.message, real.message, "the wording is identical");
  assert.equal(isRetryableFollowError(real), true, "positive control");
  assert.equal(isRetryableFollowError(impostor), false);
  assert.equal(isRestartableReadError(impostor), false);

  const httpReal = await readFailure((async () =>
    new Response(null, { status: 500 })) as typeof fetch);
  const httpImpostor = new Error(httpReal.message);
  assert.equal(httpImpostor.message, httpReal.message);
  assert.equal(followHttpDetails(httpReal)?.status, 500, "positive control");
  assert.equal(followHttpDetails(httpImpostor), null);
  assert.equal(isRestartableReadError(httpImpostor), false);
});

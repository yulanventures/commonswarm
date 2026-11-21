/** Real site DOM/transport proof with synthetic HTTP: C3 revision-bound review check thread card. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { renderAstroFixture, compileFixtureFunction } from "../../../tests/astro-fixture";
import { browserTest as test, findChrome, launchChrome } from "../../../tests/chrome.js";

function installReviewCardFixture() {
  const w = window as any;
  const owner = "33333333-3333-4333-8333-333333333333";
  const agentSec = "22222222-2222-4222-8222-000000000001";
  const agentDes = "22222222-2222-4222-8222-000000000002";
  const org = "55555555-5555-4555-8555-555555555555";
  const wsId = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const convGeneral = "eeeeeeee-eeee-4eee-8eee-000000000001";
  const convOps = "eeeeeeee-eeee-4eee-8eee-000000000002";
  const chOps = "cccccccc-cccc-4ccc-8ccc-000000000002";
  const root1 = "99999999-9999-4999-8999-000000000001";
  const root2 = "99999999-9999-4999-8999-000000000002";
  const opsRoot = "99999999-9999-4999-8999-000000000003";
  const satisfiedSignalId = "99999999-9999-4999-8999-000000000099";
  const check1Id = "11111111-1111-4111-8111-000000000001";
  const check2Id = "11111111-1111-4111-8111-000000000002";
  const sha1 = "1111111111111111111111111111111111111111";
  const sha2 = "2222222222222222222222222222222222222222";
  const scenario = new URL(location.href).searchParams.get("case") || "review-card-desktop";
  const unsupportedCase = scenario.startsWith("review-card-unsupported-");
  const retireCase = scenario.startsWith("review-card-retire-");
  const recent = new Date(Date.now() - 60_000).toISOString();
  const earlier = new Date(Date.now() - 120_000).toISOString();
  const permanent = "9999-12-31T23:59:59.000Z";
  const user = {
    id: owner,
    aud: "authenticated",
    role: "authenticated",
    email: "synthetic@example.test",
    app_metadata: {},
    user_metadata: {},
    created_at: earlier,
  };

  let releaseHeldRead: (() => void) | null = null;
  let headSha = sha1;
  let ownerVerdict: "pass" | "hold" | null = null;
  let ownerVerdictSha: string | null = null;
  let ownerNote: string | null = null;
  let secVerdictSha = sha1;
  let desVerdict: "pass" | null = null;
  let desVerdictSha: string | null = null;
  let staleOnce = true;
  let satisfiedPosted = false;

  const buildCheck1 = () => {
    const secStale = secVerdictSha !== headSha;
    const desStale = desVerdict !== null && desVerdictSha !== headSha;
    const ownerStale = ownerVerdict !== null && ownerVerdictSha !== headSha;
    const secEff = secStale ? "pending" : "pass";
    const desEff = desVerdict && !desStale ? "pass" : "pending";
    const ownerEff = ownerVerdict && !ownerStale ? ownerVerdict : "pending";
    const allPass = secEff === "pass" && desEff === "pass" && ownerEff === "pass";
    const anyHold = ownerEff === "hold";
    const status = anyHold ? "hold" : allPass ? "satisfied" : "pending";
    return {
      check_id: check1Id,
      workspace_id: wsId,
      subject: { kind: "pr", repo: "yulanventures/commonswarm", ref: "710" },
      head_sha: headSha,
      conversation_id: convGeneral,
      channel_id: null,
      thread_root_id: root1,
      required_seats: [
        { kind: "agent", id: agentSec, name: "HezSec" },
        { kind: "agent", id: agentDes, name: "Designer" },
        { kind: "user", id: owner, name: "Synthetic owner" },
      ],
      stamps: [
        {
          seat_kind: "agent",
          seat_id: agentSec,
          name: "HezSec",
          verdict: "pass",
          head_sha: secVerdictSha,
          note: "Authz verified",
          stamped_at: recent,
          stale: secStale,
          effective_verdict: secEff,
        },
        {
          seat_kind: "agent",
          seat_id: agentDes,
          name: "Designer",
          verdict: desVerdict,
          head_sha: desVerdictSha,
          note: desVerdict ? "Visual check clean" : null,
          stamped_at: desVerdict ? recent : null,
          stale: desStale,
          effective_verdict: desEff,
        },
        {
          seat_kind: "user",
          seat_id: owner,
          name: "Synthetic owner",
          verdict: ownerVerdict,
          head_sha: ownerVerdictSha,
          note: ownerNote,
          stamped_at: ownerVerdict ? new Date().toISOString() : null,
          stale: ownerStale,
          effective_verdict: ownerEff,
        },
      ],
      status,
      satisfied: allPass,
      satisfied_head_sha: allPass ? headSha : null,
      satisfied_signal_id: allPass ? satisfiedSignalId : null,
      satisfied_at: allPass ? new Date().toISOString() : null,
      created_at: earlier,
      updated_at: new Date().toISOString(),
    };
  };

  const buildReadOnlyCheck2 = () => ({
    check_id: check2Id,
    workspace_id: wsId,
    subject: { kind: "pr", repo: "yulanventures/commonswarm", ref: "711" },
    head_sha: sha1,
    conversation_id: convGeneral,
    channel_id: null,
    thread_root_id: root2,
    required_seats: [{ kind: "agent", id: agentSec, name: "HezSec" }],
    stamps: [
      {
        seat_kind: "agent",
        seat_id: agentSec,
        name: "HezSec",
        verdict: "pass",
        head_sha: sha1,
        note: null,
        stamped_at: recent,
        stale: false,
        effective_verdict: "pass",
      },
    ],
    status: "satisfied",
    satisfied: true,
    satisfied_head_sha: sha1,
    satisfied_signal_id: null,
    satisfied_at: recent,
    created_at: earlier,
    updated_at: recent,
  });

  const f = (w.reviewCardFixture = {
    scenario,
    phone: scenario.endsWith("-phone"),
    wsId,
    convGeneral,
    convOps,
    chOps,
    root1,
    root2,
    opsRoot,
    check1Id,
    check2Id,
    sha1,
    sha2,
    satisfiedSignalId,
    reviewReads: 0,
    stamps: [] as any[],
    heldRead: false,
    releaseHeldRead: () => {
      releaseHeldRead?.();
      releaseHeldRead = null;
    },
    unexpected: [] as string[],
  });

  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === location.origin) return network(input, init);
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (url.origin !== "https://api.test.invalid") {
      f.unexpected.push(url.href);
      return Response.json({}, { status: 404 });
    }
    if (url.pathname === "/auth/v1/user") return Response.json(user);
    if (url.pathname === "/rest/v1/workspaces") {
      return Response.json([{ workspace_id: wsId, org_id: org, name: "Workspace 1", archived_at: null }]);
    }
    if (url.pathname === "/rest/v1/member_profiles") {
      return Response.json([{ user_id: owner, display_name: "Synthetic owner", role: "owner" }]);
    }
    if (url.pathname === "/rest/v1/channels") {
      return Response.json([{ channel_id: chOps, slug: "ops", title: "Ops", kind: "public", archived_at: null }]);
    }
    if (url.pathname === "/rest/v1/rpc/home_overview") {
      return Response.json({
        viewer_user_id: owner,
        generated_at: new Date().toISOString(),
        workspaces: [
          {
            workspace_id: wsId,
            name: "Workspace 1",
            role: "owner",
            last_seen_at: recent,
            new_messages: 0,
            content: null,
            people: [{ user_id: owner, display_name: "Synthetic owner", role: "owner", is_viewer: true, agents: [] }],
            needs_you: { asks: [], assigned: [], waiting: [] },
          },
        ],
      });
    }
    if (url.pathname === "/rest/v1/rpc/channel_unread") {
      return Response.json({
        workspace_id: wsId,
        generated_at: new Date().toISOString(),
        channels: [
          { channel_id: null, slug: "general", unread: null },
          { channel_id: chOps, slug: "ops", unread: null },
        ],
      });
    }
    if (url.pathname === "/rest/v1/rpc/decision_queue") {
      return Response.json({ workspace_id: wsId, generated_at: new Date().toISOString(), total: 0, truncated: false, asks: [] });
    }
    if (url.pathname === "/rest/v1/rpc/waiting_todos_page") {
      return Response.json({ workspace_id: wsId, generated_at: new Date().toISOString(), total: 0, truncated: false, todos: [] });
    }
    if (url.pathname.startsWith("/rest/v1/")) return Response.json([]);
    if (url.pathname === "/functions/v1/read") {
      if (body?.resource === "conversations") {
        return Response.json({
          conversations: [
            {
              conversation_id: convGeneral,
              kind: "general",
              channel_id: null,
              slug: "general",
              description: null,
              archived_at: null,
              joined: true,
              generation: 1,
              members: [],
              notify_level: "everything",
              starred: false,
              star_rank: null,
              unread_count: 0,
              mention_count: 0,
              last_message_at: recent,
              last_message_id: root1,
            },
            {
              conversation_id: convOps,
              kind: "public_channel",
              channel_id: chOps,
              slug: "ops",
              description: null,
              archived_at: null,
              joined: true,
              generation: 1,
              members: [{ kind: "user", id: owner, name: "Synthetic owner", left_at: null }],
              notify_level: "everything",
              starred: false,
              star_rank: null,
              unread_count: 0,
              mention_count: 0,
              last_message_at: recent,
              last_message_id: opsRoot,
            },
          ],
        });
      }
      if (body?.resource === "conversation_history") {
        if (body?.conversation_id === convOps) {
          return Response.json({
            conversation: {
              conversation_id: convOps,
              kind: "public_channel",
              channel_id: chOps,
              slug: "ops",
              description: null,
              archived_at: null,
              joined: true,
              generation: 1,
              members: [{ kind: "user", id: owner, name: "Synthetic owner", left_at: null }],
              notify_level: "everything",
              starred: false,
              star_rank: null,
              unread_count: 0,
              mention_count: 0,
              last_message_at: recent,
              last_message_id: opsRoot,
            },
            messages: [
              {
                id: opsRoot,
                from: owner,
                from_kind: "user",
                to: null,
                to_agent: null,
                kind: "note",
                body: "Ops channel root",
                attachments: [],
                about: null,
                until: permanent,
                created_at: recent,
                channel_id: chOps,
                thread_root_id: null,
                in_reply_to: null,
                broadcast_to_channel: false,
                conversation_id: convOps,
              },
            ],
            has_more: false,
            next_before: null,
            next_after: { created_at: recent, id: opsRoot },
          });
        }
        const msgs: any[] = [
          {
            id: root1,
            from: owner,
            from_kind: "user",
            to: null,
            to_agent: null,
            kind: "note",
            body: "Review thread for PR #710",
            attachments: [],
            about: null,
            until: permanent,
            created_at: recent,
            channel_id: null,
            thread_root_id: null,
            in_reply_to: null,
            broadcast_to_channel: false,
            conversation_id: convGeneral,
          },
          {
            id: root2,
            from: owner,
            from_kind: "user",
            to: null,
            to_agent: null,
            kind: "note",
            body: "Agent-only review thread for PR #711",
            attachments: [],
            about: null,
            until: permanent,
            created_at: earlier,
            channel_id: null,
            thread_root_id: null,
            in_reply_to: null,
            broadcast_to_channel: false,
            conversation_id: convGeneral,
          },
        ];
        if (satisfiedPosted) {
          msgs.unshift({
            id: satisfiedSignalId,
            from: owner,
            from_kind: "user",
            to: null,
            to_agent: null,
            kind: "note",
            body: `Review check satisfied for yulanventures/commonswarm#710 at ${sha2.slice(0, 9)}.`,
            attachments: [],
            about: "yulanventures/commonswarm#710",
            until: permanent,
            created_at: new Date().toISOString(),
            channel_id: null,
            thread_root_id: root1,
            in_reply_to: null,
            broadcast_to_channel: false,
            conversation_id: convGeneral,
          });
        }
        return Response.json({
          conversation: {
            conversation_id: convGeneral,
            kind: "general",
            channel_id: null,
            slug: "general",
            description: null,
            archived_at: null,
            joined: true,
            generation: 1,
            members: [],
            notify_level: "everything",
            starred: false,
            star_rank: null,
            unread_count: 0,
            mention_count: 0,
            last_message_at: recent,
            last_message_id: msgs[0].id,
          },
          messages: msgs,
          has_more: false,
          next_before: null,
          next_after: { created_at: msgs[0].created_at, id: msgs[0].id },
        });
      }
      if (body?.resource === "review_checks") {
        f.reviewReads += 1;
        if (unsupportedCase) {
          return Response.json({ error: "unsupported_resource", message: "Unsupported read resource." }, { status: 400 });
        }
        if (retireCase && body?.conversation_id === convGeneral) {
          f.heldRead = true;
          await new Promise<void>((resolve) => {
            releaseHeldRead = resolve;
          });
          return Response.json({ review_checks: [buildCheck1()] });
        }
        if (body?.conversation_id === convOps) {
          return Response.json({ review_checks: [] });
        }
        return Response.json({ review_checks: [buildCheck1(), buildReadOnlyCheck2()] });
      }
      return Response.json(body?.resource === "pending_access" ? { pending: [], agents: [] } : { grants: [] });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "review_check_stamp") {
      f.stamps.push(body.command);
      if (body.command.verdict === "hold") {
        ownerVerdict = "hold";
        ownerVerdictSha = body.command.head_sha;
        ownerNote = body.command.note ?? null;
        return Response.json({
          status: "accepted",
          review_check: buildCheck1(),
          satisfied_now: false,
          satisfied_signal_id: null,
        });
      }
      if (body.command.verdict === "pass" && staleOnce && body.command.head_sha === sha1) {
        staleOnce = false;
        // Head moved to sha2 while viewer looked at sha1: HezSec & Designer both stamped sha2?
        // Leave HezSec stale on sha1 first, then after refresh let HezSec & Designer be pass on sha2 when viewer stamps sha2!
        headSha = sha2;
        return Response.json(
          {
            error: "stale_head",
            current_head_sha: sha2,
            message: `Head SHA has moved to ${sha2}. Re-verify the current head before stamping.`,
          },
          { status: 409 },
        );
      }
      // Second pass on sha2 completes the check (all 3 seats pass on sha2).
      secVerdictSha = sha2;
      desVerdict = "pass";
      desVerdictSha = sha2;
      ownerVerdict = "pass";
      ownerVerdictSha = sha2;
      ownerNote = body.command.note ?? null;
      satisfiedPosted = true;
      return Response.json({
        status: "accepted",
        review_check: buildCheck1(),
        satisfied_now: true,
        satisfied_signal_id: satisfiedSignalId,
      });
    }
    f.unexpected.push(`${request.method} ${url.pathname}`);
    return Response.json({ error: "unexpected_fixture_request" }, { status: 404 });
  };

  localStorage.setItem(
    "sb-api-auth-token",
    JSON.stringify({
      access_token: "synthetic-human",
      refresh_token: "synthetic-refresh",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user,
    }),
  );
}

async function observeReviewCard() {
  const w = window as any;
  const f = w.reviewCardFixture;
  const tick = async () => {
    await fetch("/__observer-tick");
  };
  const steps: string[] = [];
  const shown = (node: Element | null | undefined): boolean => {
    if (!node) return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(node).display !== "none";
  };
  const wait = async (predicate: () => unknown, label: string) => {
    for (let i = 0; i < 600; i++) {
      if (predicate()) {
        steps.push(label);
        return;
      }
      await tick();
    }
    throw new Error(`timed out at ${label}; steps=${steps.join(" | ")}, reads=${f.reviewReads}, stamps=${JSON.stringify(f.stamps)}`);
  };
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(`${message}; steps=${steps.join(" | ")}`);
  };

  try {
    if (f.scenario.startsWith("review-card-unsupported-")) {
      await wait(() => f.reviewReads >= 1 && document.body.textContent!.includes("Review thread for PR #710"), "feed rendered on pre-C3 server");
      for (let i = 0; i < 15; i++) await tick();
      check(f.reviewReads === 1, "unsupported_resource must stop polling review_checks, got " + f.reviewReads);
      check(!document.querySelector("[data-review-check]"), "no review check card should render on pre-C3 server");
      check(!document.querySelector(".hm-review-check__error"), "no error banner should appear on pre-C3 server");
      document.documentElement.dataset.reviewObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    if (f.scenario.startsWith("review-card-retire-")) {
      const opsLink = () => document.querySelector<HTMLElement>(`[data-rail-channel="${f.chOps}"]`);
      await wait(() => f.heldRead && shown(opsLink()), "#general review_checks read held in flight with #ops ready in rail");
      opsLink()!.click();
      await wait(() => opsLink()?.getAttribute("aria-current") === "page" && document.body.textContent!.includes("Ops channel root"), "switched to #ops");
      f.releaseHeldRead();
      for (let i = 0; i < 20; i++) await tick();
      check(!document.querySelector(`[data-review-check="${f.check1Id}"]`), "retired #general review check leaked into #ops");
      document.documentElement.dataset.reviewObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    const card1 = () => document.querySelector<HTMLElement>(`[data-review-check="${f.check1Id}"]`);
    const card2 = () => document.querySelector<HTMLElement>(`[data-review-check="${f.check2Id}"]`);
    await wait(() => shown(card1()) && shown(card2()), "both review check cards rendered on their thread roots");

    // 1. Initial rendering, status pill, short SHA, read-only non-seat card, touch targets, and no phone overflow.
    check(card1()!.textContent!.includes("yulanventures/commonswarm#710"), "missing subject on card 1");
    check(card1()!.textContent!.includes("@ 111111111"), "missing 9-char head SHA on card 1");
    check(card1()!.dataset.reviewStatus === "pending", "expected pending status on card 1");
    check(card1()!.textContent!.includes("Pending") && card1()!.textContent!.includes("1/3"), "expected Pending 1/3 on card 1");
    check(card2()!.querySelectorAll("[data-review-stamp]").length === 0, "non-required viewer must see strictly read-only card 2");

    const passBtn1 = card1()!.querySelector<HTMLButtonElement>('[data-review-stamp="pass"]')!;
    const holdBtn1 = card1()!.querySelector<HTMLButtonElement>('[data-review-stamp="hold"]')!;
    const noteInput1 = card1()!.querySelector<HTMLInputElement>("[data-review-check-note]")!;
    check(passBtn1.getBoundingClientRect().height >= 44 && holdBtn1.getBoundingClientRect().height >= 44 && noteInput1.getBoundingClientRect().height >= 44,
      "review check controls must meet 44px touch targets");
    if (f.phone) {
      check(card1()!.getBoundingClientRect().right <= innerWidth + 1, "review check card overflowed phone viewport");
    }

    // 2. Viewer enters note and clicks Hold -> card updates to Hold with note and aria-pressed="true".
    noteInput1.value = "Needs migration witness";
    noteInput1.dispatchEvent(new Event("input", { bubbles: true }));
    holdBtn1.click();
    await wait(
      () =>
        card1()?.dataset.reviewStatus === "hold" &&
        card1()?.textContent!.includes("Needs migration witness") &&
        card1()?.querySelector<HTMLButtonElement>('[data-review-stamp="hold"]')?.getAttribute("aria-pressed") === "true",
      "Hold verdict recorded with note and aria-pressed",
    );
    check(f.stamps.length === 1 && f.stamps[0].verdict === "hold" && f.stamps[0].head_sha === f.sha1 && f.stamps[0].note === "Needs migration witness",
      "unexpected Hold command payload: " + JSON.stringify(f.stamps));

    // 3. Viewer clicks Pass on old head -> 409 stale_head -> error alert + auto-refresh to sha2 with stale old-head badges!
    const readsBeforeStale = f.reviewReads;
    card1()!.querySelector<HTMLButtonElement>('[data-review-stamp="pass"]')!.click();
    await wait(
      () =>
        f.reviewReads > readsBeforeStale &&
        card1()?.dataset.reviewHead === f.sha2 &&
        shown(card1()?.querySelector('[role="alert"]')) &&
        card1()!.textContent!.includes("Pending · old pass @ 111111111") &&
        card1()!.textContent!.includes("Pending · old hold @ 111111111"),
      "409 stale_head showed alert, refreshed to sha2, and marked old stamps stale",
    );
    check(!card1()!.textContent!.includes("Needs migration witness"), "stale old-head note must not display as current after head move");

    // 4. Viewer clicks Pass on sha2 -> satisfied_now -> card updates to Ready (3/3) and once-only satisfied note appears!
    const passOnSha2 = card1()!.querySelector<HTMLButtonElement>('[data-review-stamp="pass"]')!;
    passOnSha2.focus();
    passOnSha2.click();
    await wait(
      () =>
        card1()?.dataset.reviewStatus === "satisfied" &&
        card1()!.textContent!.includes("Ready") &&
        card1()!.textContent!.includes("3/3") &&
        document.body.textContent!.includes("Review check satisfied for yulanventures/commonswarm#710 at 222222222."),
      "Pass on sha2 transitioned card to Ready (3/3) and loaded satisfied thread note",
    );
    check(document.activeElement !== document.body && Boolean(card1()?.contains(document.activeElement)),
      "focus must remain inside review check card after stamping");

    document.documentElement.dataset.reviewObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
  } catch (error) {
    document.documentElement.dataset.reviewObservation = JSON.stringify({ error: String(error), scenario: f.scenario, steps, unexpected: f.unexpected });
  }
}

async function runReviewCardScenarios(scenarios: readonly string[]): Promise<Record<string, any>> {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const compileFixture = (name: string) => compileFixtureFunction(new URL(import.meta.url), name);
  const app =
    "<!doctype html><html><head><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" +
    styles.join("\n") +
    "</style><script>" +
    (await compileFixture("installReviewCardFixture")) +
    "</script></head><body>" +
    markup +
    "<script>" +
    (await compileFixture("observeReviewCard")) +
    "</script></body></html>";

  const server = createServer((request, response) => {
    if (request.url === "/__observer-tick") {
      setTimeout(() => {
        response.writeHead(204);
        response.end();
      }, 2);
      return;
    }
    if (request.url?.startsWith("/fonts/")) {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": request.url === "/app.js" ? "text/javascript" : "text/html" });
    response.end(request.url === "/app.js" ? bundled.join("\n") : app);
  });

  const outcomes: Record<string, any> = {};
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const chrome = await findChrome();
    for (const scenario of scenarios) {
      const size = scenario.endsWith("-phone") ? "390,844" : "1280,800";
      const { stdout } = await launchChrome(
        chrome,
        [
          `--window-size=${size}`,
          "--virtual-time-budget=120000",
          "--dump-dom",
          `http://127.0.0.1:${address.port}/app?w=aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa&c=general&case=${scenario}`,
        ],
        { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
      );
      const raw = stdout.match(/data-review-observation="([^"]*)"/)?.[1];
      outcomes[scenario] = raw
        ? JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"))
        : { error: "the rendered app did not finish the observation: " + stdout.slice(0, 400) };
    }
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
  return outcomes;
}

const failures = (outcomes: Record<string, any>) =>
  Object.entries(outcomes).filter(([, result]) => result.error !== undefined || result.ok !== true);

test("C3 review check thread card: renders status, stamps Hold/Pass, handles 409 stale_head, falls back on pre-C3 servers, and retires across channel switch", { timeout: 180_000 }, async () => {
  const outcomes = await runReviewCardScenarios([
    "review-card-desktop",
    "review-card-phone",
    "review-card-unsupported-desktop",
    "review-card-retire-desktop",
  ]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});

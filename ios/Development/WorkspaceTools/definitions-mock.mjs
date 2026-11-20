// Loopback simulator fixture for iPhone Workspace Definitions (Rank 11).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const verify = process.argv[2] === "--verify";
const requestedPort = verify ? 0 : Number(process.env.DEFINITIONS_FIXTURE_PORT || 8765);
let origin;

const me = "00000000-0000-4000-8000-000000000001";
const atlas = "00000000-0000-4000-8000-000000000002";
const maya = "00000000-0000-4000-8000-000000000011";
const wsMain = "00000000-0000-4000-8000-000000000003";
const seat = "seat_0000000000000000000000";

const workspaces = [{ workspace_id: wsMain, name: "Simulator workspace" }];

const makeToken = (prefix, seq) => `${prefix}_rev_${String(seq).padStart(16, "0")}`;

const makeRev = (objectId, seq) => ({
  workspace_id: wsMain,
  object_id: objectId,
  token: makeToken(objectId.replace(/[^a-zA-Z0-9_-]/g, "_"), seq),
});

const definitions = new Map();
const seedDefinitions = () => {
  definitions.clear();
  const arrV1 = makeRev("def-arr", 1);
  const arrV2 = makeRev("def-arr", 2);
  definitions.set("def-arr", {
    object_id: "def-arr",
    seq: 2,
    current: {
      revision: arrV2,
      term: "ARR",
      meaning: "Annualized recurring subscription revenue excluding one-time onboarding fees.",
      source: "stripe.subscriptions + billing.v2",
      author: { user_id: maya, principal_id: atlas },
      occurred_at_server: Date.now() - 25 * 60 * 1000,
    },
    certified: {
      revision: arrV1,
      term: "ARR",
      meaning: "Annualized recurring subscription revenue.",
      source: "stripe.subscriptions",
      certified_by: maya,
      certified_at: Date.now() - 3 * 86400 * 1000,
    },
  });

  const nrrV1 = makeRev("def-nrr", 1);
  definitions.set("def-nrr", {
    object_id: "def-nrr",
    seq: 1,
    current: {
      revision: nrrV1,
      term: "NRR",
      meaning: "Net revenue retention across active annual cohorts including expansion and churn.",
      source: "warehouse.mart_retention",
      author: { user_id: maya, principal_id: null },
      occurred_at_server: Date.now() - 5 * 86400 * 1000,
    },
    certified: {
      revision: nrrV1,
      term: "NRR",
      meaning: "Net revenue retention across active annual cohorts including expansion and churn.",
      source: "warehouse.mart_retention",
      certified_by: { user_id: maya },
      certified_at: new Date(Date.now() - 5 * 86400 * 1000).toISOString(),
    },
  });

  const actV1 = makeRev("def-activation-window", 1);
  definitions.set("def-activation-window", {
    object_id: "def-activation-window",
    seq: 1,
    current: {
      revision: actV1,
      term: "Activation window",
      meaning: "First 14 calendar days after workspace creation during which a team completes its first workflow.",
      source: "product.funnel_events",
      author: { user_id: me, principal_id: atlas },
      occurred_at_server: Date.now() - 90 * 60 * 1000,
    },
    certified: null,
  });
};
seedDefinitions();

let contentRole = "editor";
let accessRefused = false;
let edge403Mode = false;
let edge401Mode = false;
let edge404Mode = false;
let consentNeeded = false;
let unsupportedMode = false;
let failNextWrite = false;
let commitThen503NextWrite = false;
let preReceiptRefusalOnce = null;
let conflictNextUpdate = false;
let staleNextCertify = false;
let holdNextList = false;
let heldListResolver = null;
let holdNextWrite = false;
let heldWriteResolver = null;
let omitObjectInSearchOnce = null;
let writeMutations = 0;
let rosterReadCount = 0;
const receipts = new Map();
const recordedCommands = [];

let emailCodePending = false;
const sessions = new Set();
const refreshTokens = new Set();

const server = createServer(async (req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  };
  try {
    const url = new URL(req.url, origin);
    if (req.headers.host !== new URL(origin).host) return reply(400, {});

    if (req.method === "POST" && url.pathname === "/fixture/role") {
      contentRole = url.searchParams.get("role") === "reader" ? "reader" : "editor";
      return reply(200, { ok: true, contentRole });
    }
    if (req.method === "POST" && url.pathname === "/fixture/access-refused") {
      accessRefused = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, accessRefused });
    }
    if (req.method === "POST" && url.pathname === "/fixture/edge-403") {
      edge403Mode = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, edge403Mode });
    }
    if (req.method === "POST" && url.pathname === "/fixture/edge-401") {
      edge401Mode = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, edge401Mode });
    }
    if (req.method === "POST" && url.pathname === "/fixture/edge-404") {
      edge404Mode = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, edge404Mode });
    }
    if (req.method === "POST" && url.pathname === "/fixture/consent-needed") {
      consentNeeded = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, consentNeeded });
    }
    if (req.method === "POST" && url.pathname === "/fixture/unsupported") {
      unsupportedMode = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, unsupportedMode });
    }
    if (req.method === "POST" && url.pathname === "/fixture/fail-next-write") {
      failNextWrite = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/commit-then-503") {
      commitThen503NextWrite = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/pre-receipt-refusal") {
      preReceiptRefusalOnce = url.searchParams.get("reason") || "rate_limited";
      return reply(200, { ok: true, preReceiptRefusalOnce });
    }
    if (req.method === "POST" && url.pathname === "/fixture/conflict-next-update") {
      conflictNextUpdate = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/stale-next-certify") {
      staleNextCertify = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/hold-next-list") {
      holdNextList = true;
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/fixture/list-held") {
      return reply(200, { held: heldListResolver !== null });
    }
    if (req.method === "POST" && url.pathname === "/fixture/release-held-list") {
      if (heldListResolver) {
        const resolve = heldListResolver;
        heldListResolver = null;
        resolve();
      }
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/hold-next-write") {
      holdNextWrite = true;
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/fixture/write-held") {
      return reply(200, { held: heldWriteResolver !== null });
    }
    if (req.method === "POST" && url.pathname === "/fixture/release-held-write") {
      if (heldWriteResolver) {
        const resolve = heldWriteResolver;
        heldWriteResolver = null;
        resolve();
      }
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/omit-in-search") {
      omitObjectInSearchOnce = url.searchParams.get("object_id") || null;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/clear-definitions") {
      definitions.clear();
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/fixture/commands") {
      return reply(200, recordedCommands);
    }
    if (req.method === "GET" && url.pathname === "/fixture/mutations") {
      return reply(200, { count: writeMutations });
    }
    if (req.method === "GET" && url.pathname === "/fixture/roster-reads") {
      return reply(200, { count: rosterReadCount });
    }
    if (req.method === "POST" && url.pathname === "/fixture/advance-proposal") {
      const targetId = url.searchParams.get("object_id") || "def-arr";
      const entry = definitions.get(targetId);
      if (entry) {
        entry.seq += 1;
        const nextRev = makeRev(entry.object_id, entry.seq);
        entry.current = {
          ...entry.current,
          revision: nextRev,
          meaning: `${entry.current.meaning} (later proposal v${entry.seq})`,
          author: { user_id: maya, principal_id: atlas },
          occurred_at_server: Date.now(),
        };
      }
      return reply(200, { ok: true, seq: entry?.seq ?? null });
    }

    if (req.headers.apikey !== "local-fixture") return reply(401, {});

    let body;
    if (req.method === "POST") {
      let data = "";
      for await (const chunk of req) {
        data += chunk;
        if (data.length > 65_536) return reply(413, {});
      }
      body = data ? JSON.parse(data) : {};
    }

    const issueSession = () => {
      const access = randomBytes(32).toString("hex");
      const refresh = randomBytes(32).toString("hex");
      sessions.add(access);
      refreshTokens.add(refresh);
      return reply(200, { access_token: access, refresh_token: refresh, expires_in: 3600, user: { id: me } });
    };

    if (req.method === "POST" && url.pathname === "/auth/v1/otp") {
      if (body.create_user !== false || url.search) return reply(400, {});
      if (body.email !== "reader@example.test") return reply(422, { code: 422, error_code: "otp_disabled" });
      emailCodePending = true;
      return reply(200, {});
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/verify") {
      if (!emailCodePending || body.email !== "reader@example.test" || body.token !== "012345" || body.type !== "email") {
        return reply(403, {});
      }
      emailCodePending = false;
      return issueSession();
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      if (!refreshTokens.has(body.refresh_token)) return reply(400, { error_code: "refresh_token_not_found" });
      refreshTokens.delete(body.refresh_token);
      return issueSession();
    }

    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!sessions.has(token)) return reply(401, {});

    if (req.method === "POST" && url.pathname === "/functions/v1/read") {
      const convGeneral = {
        conversation_id: "40000000-0000-4000-8000-000000000001",
        kind: "general",
        channel_id: null,
        slug: null,
        description: null,
        archived_at: null,
        joined: true,
        members: [
          { kind: "user", id: me, name: "You", left_at: null },
          { kind: "user", id: maya, name: "Maya Chen", left_at: null },
          { kind: "agent", id: atlas, name: "Atlas", left_at: null },
        ],
        last_message_at: "2026-11-19T14:00:00.000Z",
        notify_level: "all",
        mention_count: 0,
        unread_count: 0,
      };
      if (body.resource === "conversations") return reply(200, { conversations: [convGeneral] });
      if (body.resource === "conversation_history") return reply(200, { conversation: convGeneral, messages: [] });
      return reply(400, { error: "invalid_request" });
    }

    if (req.method === "POST" && url.pathname === "/functions/v1/command") {
      const cmd = body.command;
      // Production-shaped command-edge auth/membership/workspace errors BEFORE household handler
      if (edge401Mode) return reply(401, { message: "JWT expired" });
      if (edge403Mode) return reply(403, { error: "forbidden" });
      if (edge404Mode) return reply(404, { error: "not_found" });

      if (cmd?.kind === "household_access") {
        if (accessRefused) return reply(403, { status: "refused", reason: "workspace_access_refused" });
        if (consentNeeded) return reply(200, { status: "refused", reason: "content_consent_required" });
        const ops = contentRole === "editor" ? ["read", "create", "update"] : ["read"];
        return reply(200, { status: "ok", content_role: contentRole, operations: ops });
      }

      if (cmd?.kind === "household_definition_certify") {
        recordedCommands.push({ command_id: body.command_id, kind: cmd.kind, object_id: cmd.object_id, token: cmd.revision?.token });
        // Pre-receipt refusal checks happen BEFORE receipt lookup (matches src/protocol/household-objects.ts:281-297)
        if (preReceiptRefusalOnce) {
          const reason = preReceiptRefusalOnce;
          preReceiptRefusalOnce = null;
          return reply(403, { status: "refused", reason });
        }
        if (accessRefused) return reply(403, { status: "refused", reason: "workspace_access_refused" });
        if (contentRole !== "editor") return reply(403, { status: "refused", reason: "content_read_only" });
        if (receipts.has(body.command_id)) {
          return reply(200, { ...receipts.get(body.command_id), replayed: true });
        }
        if (failNextWrite) {
          failNextWrite = false;
          return reply(503, { error: "temporary_unavailable" });
        }
        const entry = definitions.get(cmd.object_id);
        if (!entry) return reply(404, { status: "refused", reason: "revision_not_found" });
        if (staleNextCertify || cmd.revision?.token !== entry.current.revision.token) {
          staleNextCertify = false;
          return reply(409, { status: "refused", reason: "definition_not_current" });
        }
        entry.certified = {
          revision: entry.current.revision,
          term: entry.current.term,
          meaning: entry.current.meaning,
          source: entry.current.source,
          certified_by: me,
          certified_at: Date.now(),
        };
        writeMutations += 1;
        const committed = { status: "committed", object_id: entry.object_id, revision: entry.current.revision };
        receipts.set(body.command_id, committed);
        if (holdNextWrite) {
          holdNextWrite = false;
          await new Promise((resolve) => { heldWriteResolver = resolve; });
        }
        if (commitThen503NextWrite) {
          commitThen503NextWrite = false;
          return reply(503, { error: "gateway_timeout" });
        }
        return reply(200, committed);
      }

      if (cmd?.kind === "household_tool") {
        if (cmd.arguments?.seat !== seat) return reply(403, { status: "refused", reason: "seat_binding_mismatch" });
        if (accessRefused) return reply(403, { status: "refused", reason: "workspace_access_refused" });
        if (consentNeeded) return reply(200, { status: "refused", reason: "content_consent_required" });

        if (cmd.tool === "definitions_search") {
          if (unsupportedMode) return reply(400, { status: "refused", reason: "unknown_tool" });
          const omitted = omitObjectInSearchOnce;
          omitObjectInSearchOnce = null;
          const sorted = Array.from(definitions.values())
            .filter((entry) => entry.object_id !== omitted)
            .sort((a, b) =>
              a.current.term.toLowerCase().localeCompare(b.current.term.toLowerCase()) || a.object_id.localeCompare(b.object_id)
            );
          const offset = Number(cmd.arguments?.offset ?? 0);
          const limit = Number(cmd.arguments?.limit ?? 100);
          const slice = sorted.slice(offset, offset + limit).map((entry) => ({
            object_id: entry.object_id,
            term: entry.current.term,
            revision: entry.current.revision,
            certification: entry.certified
              ? {
                  revision: entry.certified.revision,
                  certified_by: entry.certified.certified_by,
                  certified_at: entry.certified.certified_at,
                }
              : null,
          }));
          const payload = {
            status: "ok",
            definitions: slice,
            next_offset: offset + limit < sorted.length ? offset + limit : null,
          };
          if (holdNextList) {
            holdNextList = false;
            await new Promise((resolve) => { heldListResolver = resolve; });
          }
          return reply(200, payload);
        }

        if (cmd.tool === "definition_read") {
          const entry = definitions.get(cmd.arguments?.object_id);
          if (!entry) return reply(404, { status: "refused", reason: "revision_not_found" });
          return reply(200, {
            status: "ok",
            object_id: entry.object_id,
            current: entry.current,
            certified: entry.certified,
            proposal_pending: entry.certified?.revision.token !== entry.current.revision.token,
          });
        }

        if (cmd.tool === "definition_create") {
          const args = cmd.arguments;
          recordedCommands.push({ command_id: body.command_id, kind: "definition_create", object_id: args.object_id, request_id: args.request_id });
          if (preReceiptRefusalOnce) {
            const reason = preReceiptRefusalOnce;
            preReceiptRefusalOnce = null;
            return reply(403, { status: "refused", reason });
          }
          if (contentRole !== "editor") return reply(403, { status: "refused", reason: "content_read_only" });
          if (args.request_id !== body.command_id) return reply(400, { status: "refused", reason: "request_id_mismatch" });
          if (receipts.has(body.command_id)) {
            return reply(200, { ...receipts.get(body.command_id), replayed: true });
          }
          if (failNextWrite) {
            failNextWrite = false;
            return reply(503, { error: "temporary_unavailable" });
          }
          const termKey = String(args.term ?? "").trim().toLowerCase();
          for (const existing of definitions.values()) {
            if (existing.current.term.trim().toLowerCase() === termKey) {
              return reply(409, { status: "refused", reason: "definition_term_taken" });
            }
          }
          const rev = makeRev(args.object_id, 1);
          definitions.set(args.object_id, {
            object_id: args.object_id,
            seq: 1,
            current: {
              revision: rev,
              term: args.term,
              meaning: args.meaning,
              source: args.source ?? "",
              author: { user_id: me, principal_id: null },
              occurred_at_server: Date.now(),
            },
            certified: null,
          });
          writeMutations += 1;
          const committed = { status: "committed", object_id: args.object_id, revision: rev };
          receipts.set(body.command_id, committed);
          if (holdNextWrite) {
            holdNextWrite = false;
            await new Promise((resolve) => { heldWriteResolver = resolve; });
          }
          if (commitThen503NextWrite) {
            commitThen503NextWrite = false;
            return reply(503, { error: "gateway_timeout" });
          }
          return reply(200, committed);
        }

        if (cmd.tool === "definition_update") {
          const args = cmd.arguments;
          recordedCommands.push({
            command_id: body.command_id,
            kind: "definition_update",
            object_id: args.object_id,
            request_id: args.request_id,
            base_token: args.base?.token ?? null,
          });
          if (preReceiptRefusalOnce) {
            const reason = preReceiptRefusalOnce;
            preReceiptRefusalOnce = null;
            return reply(403, { status: "refused", reason });
          }
          if (contentRole !== "editor") return reply(403, { status: "refused", reason: "content_read_only" });
          if (args.request_id !== body.command_id) return reply(400, { status: "refused", reason: "request_id_mismatch" });
          if (receipts.has(body.command_id)) {
            return reply(200, { ...receipts.get(body.command_id), replayed: true });
          }
          if (failNextWrite) {
            failNextWrite = false;
            return reply(503, { error: "temporary_unavailable" });
          }
          const entry = definitions.get(args.object_id);
          if (!entry) return reply(404, { status: "refused", reason: "revision_not_found" });
          if (conflictNextUpdate || args.base?.token !== entry.current.revision.token) {
            conflictNextUpdate = false;
            // Advance server revision so reload reflects another editor's saved version
            entry.seq += 1;
            const newerRev = makeRev(entry.object_id, entry.seq);
            entry.current = {
              ...entry.current,
              revision: newerRev,
              meaning: `${entry.current.meaning} (concurrent server edit)`,
              occurred_at_server: Date.now(),
            };
            return reply(409, { status: "conflict", object_id: entry.object_id, current: entry.current.revision });
          }
          entry.seq += 1;
          const nextRev = makeRev(entry.object_id, entry.seq);
          entry.current = {
            revision: nextRev,
            term: args.after.term,
            meaning: args.after.meaning,
            source: args.after.source ?? "",
            author: { user_id: me, principal_id: null },
            occurred_at_server: Date.now(),
          };
          writeMutations += 1;
          const committed = { status: "committed", object_id: entry.object_id, revision: nextRev };
          receipts.set(body.command_id, committed);
          if (holdNextWrite) {
            holdNextWrite = false;
            await new Promise((resolve) => { heldWriteResolver = resolve; });
          }
          if (commitThen503NextWrite) {
            commitThen503NextWrite = false;
            return reply(503, { error: "gateway_timeout" });
          }
          return reply(200, committed);
        }
      }
      return reply(400, { error: "invalid_request" });
    }

    if (req.method !== "GET" || req.headers["accept-profile"] !== "swarm_read") return reply(400, {});
    if (url.pathname === "/rest/v1/workspaces") return reply(200, workspaces);

    const wsParam = url.searchParams.get("workspace_id")?.toLowerCase();
    if (wsParam !== `eq.${wsMain}`) return reply(403, {});

    switch (url.pathname) {
      case "/rest/v1/member_profiles":
        rosterReadCount += 1;
        return reply(200, [
          { user_id: me, display_name: "You" },
          { user_id: maya, display_name: "Maya Chen" },
        ]);
      case "/rest/v1/agent_principals":
        rosterReadCount += 1;
        return reply(200, [{ principal_id: atlas, name: "Atlas" }]);
      default:
        return reply(404, {});
    }
  } catch {
    return reply(400, {});
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  const actualPort = server.address().port;
  origin = `http://127.0.0.1:${actualPort}`;
  if (!verify) {
    console.log(`Definitions fixture listening on loopback port ${actualPort}`);
    return;
  }
  const child = spawn(process.argv[3], [String(actualPort), ...process.argv.slice(4)], { stdio: "inherit" });
  child.once("error", () => { process.exitCode = 1; server.close(); });
  child.once("exit", (status) => {
    process.exitCode = status ?? 1;
    server.close();
  });
});

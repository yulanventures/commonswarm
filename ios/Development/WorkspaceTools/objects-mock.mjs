// Loopback simulator fixture for iPhone Lists & docs (PR 1 + PR 2: create, edit lists/docs, history, 3-way conflict draft recovery).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const verify = process.argv[2] === "--verify";
const requestedPort = verify ? 0 : Number(process.env.OBJECTS_FIXTURE_PORT || 8765);
let origin;

const me = "00000000-0000-4000-8000-000000000001";
const atlas = "00000000-0000-4000-8000-000000000002";
const maya = "00000000-0000-4000-8000-000000000011";
const wsMain = "00000000-0000-4000-8000-000000000003";

const workspaces = [{ workspace_id: wsMain, name: "Simulator workspace" }];

let accessMode = "editor"; // editor | reader | consent | refused
let failNextUpdate = false;
let failNextCreate = false;
let failNextReadStatus = null; // e.g. 503
let refuseNextReadReason = null; // e.g. "workspace_access_refused"
let conflictNextUpdate = false;
let wrongDraftOwnerOnce = false;
let forceObjectListPageSize = null;
let forceHistoryPageSize = null;
const receivedUpdates = [];
const receivedCreates = [];
let readCount = 0;
let draftCounter = 0;
const drafts = new Map();

function cloneContent(c) {
  return JSON.parse(JSON.stringify(c));
}

function makeRevRef(objectId, token) {
  return { workspace_id: wsMain, object_id: objectId, token };
}

function makeObjects() {
  const groceriesRev1 = {
    revision: makeRevRef("obj_groceries", "rev_groceries_0"),
    parent: null,
    title: "Weekend groceries and hardware run",
    kind: "list",
    author: { user_id: me, principal_id: null, run_id: null, connection_id: null, grant_id: null },
    occurred_at_server: 1795104000000,
    live: true,
    content: {
      kind: "list",
      items: [
        { item_id: "item_milk", text: "Oat milk and espresso beans", order: 0, checked: false },
        { item_id: "item_bulbs", text: "Warm white LED bulbs for porch", order: 1, checked: false },
      ],
    },
  };
  const groceriesRev2 = {
    revision: makeRevRef("obj_groceries", "rev_groceries_1"),
    parent: groceriesRev1.revision,
    title: "Weekend groceries and hardware run",
    kind: "list",
    author: { user_id: maya, principal_id: null, run_id: null, connection_id: null, grant_id: null },
    occurred_at_server: 1795110000000,
    live: true,
    content: {
      kind: "list",
      items: [
        { item_id: "item_milk", text: "Oat milk and espresso beans", order: 0, checked: false },
        { item_id: "item_bulbs", text: "Warm white LED bulbs for porch", order: 1, checked: true },
        { item_id: "item_tape", text: "Painter’s tape for hallway trim", order: 2, checked: false },
      ],
    },
  };

  const runbookRev1 = {
    revision: makeRevRef("obj_runbook", "rev_runbook_1"),
    parent: null,
    title: "iOS TestFlight release runbook",
    kind: "doc",
    author: { user_id: maya, principal_id: null, run_id: null, connection_id: null, grant_id: null },
    occurred_at_server: 1795108000000,
    live: true,
    content: {
      kind: "doc",
      markdown: "# Pre-flight checklist\n\nInitial draft before adding TestFlight steps.",
    },
  };
  const runbookRev2 = {
    revision: makeRevRef("obj_runbook", "rev_runbook_2"),
    parent: runbookRev1.revision,
    title: "iOS TestFlight release runbook",
    kind: "doc",
    author: { user_id: me, principal_id: atlas, run_id: null, connection_id: null, grant_id: null },
    occurred_at_server: 1795117200000,
    live: true,
    content: {
      kind: "doc",
      markdown: [
        "# Pre-flight checklist",
        "",
        "Review the [release checklist](https://example.test/checklist) before tagging a build.",
        "",
        "## Required checks",
        "- Verify light and dark mode contrast on iPhone SE and large iPhone.",
        "- Confirm sign-in session restoration after upgrade.",
        "",
        "## Steps",
        "1. Run local Swift verifiers.",
        "2. Archive and upload to TestFlight.",
        "",
        "```",
        "bash ios/Development/verify.sh",
        "```",
      ].join("\n"),
    },
  };

  const fileRev1 = {
    revision: makeRevRef("obj_invoice_pdf", "rev_file_1"),
    parent: null,
    title: "Q4-invoice.pdf",
    kind: "file",
    author: { user_id: maya, principal_id: null, run_id: null, connection_id: null, grant_id: null },
    occurred_at_server: 1795100000000,
    live: true,
    content: { kind: "file", name: "Q4-invoice.pdf", media_type: "application/pdf" },
  };

  return new Map([
    ["obj_groceries", {
      object_id: "obj_groceries",
      kind: "list",
      title: groceriesRev2.title,
      token: groceriesRev2.revision.token,
      revCounter: 1,
      author: groceriesRev2.author,
      occurred_at_server: groceriesRev2.occurred_at_server,
      content: cloneContent(groceriesRev2.content),
      revisions: [groceriesRev2, groceriesRev1],
    }],
    ["obj_runbook", {
      object_id: "obj_runbook",
      kind: "doc",
      title: runbookRev2.title,
      token: runbookRev2.revision.token,
      revCounter: 2,
      author: runbookRev2.author,
      occurred_at_server: runbookRev2.occurred_at_server,
      content: cloneContent(runbookRev2.content),
      revisions: [runbookRev2, runbookRev1],
    }],
    ["obj_invoice_pdf", {
      object_id: "obj_invoice_pdf",
      kind: "file",
      title: fileRev1.title,
      token: fileRev1.revision.token,
      revCounter: 1,
      author: fileRev1.author,
      occurred_at_server: fileRev1.occurred_at_server,
      content: cloneContent(fileRev1.content),
      revisions: [fileRev1],
    }],
  ]);
}

let objects = makeObjects();
let emailCodePending = false;
const sessions = new Set();
const refreshTokens = new Set();

function revRef(obj) {
  return makeRevRef(obj.object_id, obj.token);
}

function applyListPatch(items, operations) {
  const next = [...items].sort((a, b) => a.order - b.order).map((i) => ({ ...i }));
  for (const op of operations) {
    if (op.kind === "set") {
      const idx = next.findIndex((i) => i.item_id === op.item_id);
      if (idx < 0) return null;
      if (next[idx].text !== op.before_text || next[idx].checked !== op.before_checked) return null;
      next[idx].text = op.text;
      next[idx].checked = op.checked;
    } else if (op.kind === "remove") {
      const idx = next.findIndex((i) => i.item_id === op.item_id);
      if (idx < 0) return null;
      if (next[idx].text !== op.before_text || next[idx].checked !== op.before_checked) return null;
      next.splice(idx, 1);
    } else if (op.kind === "add") {
      if (next.some((i) => i.item_id === op.item_id)) return null;
      const newItem = { item_id: op.item_id, text: op.text, checked: Boolean(op.checked), order: 0 };
      if (op.after_item_id === null) {
        next.unshift(newItem);
      } else {
        const idx = next.findIndex((i) => i.item_id === op.after_item_id);
        if (idx < 0) return null;
        next.splice(idx + 1, 0, newItem);
      }
    } else if (op.kind === "move") {
      const idx = next.findIndex((i) => i.item_id === op.item_id);
      if (idx < 0 || idx !== op.before_order) return null;
      const [moved] = next.splice(idx, 1);
      if (op.after_item_id === null) {
        next.unshift(moved);
      } else {
        const afterIdx = next.findIndex((i) => i.item_id === op.after_item_id);
        if (afterIdx < 0) return null;
        next.splice(afterIdx + 1, 0, moved);
      }
    } else {
      return null;
    }
  }
  return next.map((item, idx) => ({ ...item, order: idx }));
}

function applyDocPatch(markdown, splices) {
  let text = String(markdown);
  for (const sp of splices) {
    const start = Number(sp.start);
    const before = String(sp.before ?? "");
    const after = String(sp.after ?? "");
    if (!Number.isInteger(start) || start < 0 || text.slice(start, start + before.length) !== before) {
      return null;
    }
    text = text.slice(0, start) + after + text.slice(start + before.length);
  }
  return text;
}

function applyContentPatch(content, patch) {
  if (!patch) return null;
  if (content.kind === "list" && patch.kind === "list") {
    const updated = applyListPatch(content.items ?? [], patch.operations ?? []);
    return updated ? { kind: "list", items: updated } : null;
  }
  if (content.kind === "doc" && patch.kind === "doc") {
    const updated = applyDocPatch(content.markdown ?? "", patch.splices ?? []);
    return updated !== null ? { kind: "doc", markdown: updated } : null;
  }
  return null;
}

function snapshotWire(snap) {
  return {
    revision: snap.revision,
    title: snap.title,
    author: snap.author,
    occurred_at_server: snap.occurred_at_server,
    live: snap.live ?? true,
    content: cloneContent(snap.content),
  };
}

const server = createServer(async (req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  };
  try {
    const url = new URL(req.url, origin);
    if (req.headers.host !== new URL(origin).host) return reply(400, {});

    if (req.method === "POST" && url.pathname === "/fixture/access-mode") {
      accessMode = url.searchParams.get("mode") || "editor";
      return reply(200, { ok: true, accessMode });
    }
    if (req.method === "POST" && url.pathname === "/fixture/fail-next-update") {
      failNextUpdate = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/fail-next-create") {
      failNextCreate = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/fail-next-read") {
      failNextReadStatus = Number(url.searchParams.get("status") || 503);
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/refuse-next-read") {
      refuseNextReadReason = url.searchParams.get("reason") || "workspace_access_refused";
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/conflict-next-update") {
      conflictNextUpdate = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/wrong-draft-owner") {
      wrongDraftOwnerOnce = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/list-page-size") {
      const n = url.searchParams.get("n");
      forceObjectListPageSize = n ? Number(n) : null;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/history-page-size") {
      const n = url.searchParams.get("n");
      forceHistoryPageSize = n ? Number(n) : null;
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/fixture/updates") {
      return reply(200, receivedUpdates);
    }
    if (req.method === "GET" && url.pathname === "/fixture/creates") {
      return reply(200, receivedCreates);
    }
    if (req.method === "GET" && url.pathname === "/fixture/read-count") {
      return reply(200, { count: readCount });
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
      if (body.resource === "conversations") {
        return reply(200, { conversations: [convGeneral] });
      }
      if (body.resource === "conversation_history") {
        return reply(200, { conversation: convGeneral, messages: [] });
      }
      return reply(400, { error: "invalid_request" });
    }

    if (req.method === "POST" && url.pathname === "/functions/v1/command") {
      const cmd = body.command;
      if (cmd?.kind === "household_access") {
        if (accessMode === "consent") {
          return reply(200, { status: "refused", reason: "content_consent_required" });
        }
        if (accessMode === "refused") {
          return reply(200, { status: "refused", reason: "workspace_access_refused" });
        }
        if (accessMode === "reader") {
          return reply(200, { status: "ok", content_role: "reader", operations: ["read"] });
        }
        return reply(200, { status: "ok", content_role: "editor", operations: ["read", "create", "update"] });
      }

      if (cmd?.kind === "household_draft") {
        if (accessMode === "refused") return reply(200, { status: "refused", reason: "workspace_access_refused" });
        if (accessMode === "consent") return reply(200, { status: "refused", reason: "content_consent_required" });
        const draft = drafts.get(String(cmd.draft_id || ""));
        if (!draft) return reply(200, { status: "refused", reason: "draft_not_found" });
        let owner = draft.owner_user_id;
        if (wrongDraftOwnerOnce) {
          wrongDraftOwnerOnce = false;
          owner = maya;
        }
        return reply(200, {
          status: "ok",
          workspace_id: draft.workspace_id,
          object_id: draft.object_id,
          draft_id: draft.draft_id,
          owner_user_id: owner,
          proposed: cloneContent(draft.proposed),
          base: snapshotWire(draft.base),
          current: snapshotWire(draft.current),
        });
      }

      if (cmd?.kind === "household_tool") {
        const args = cmd.arguments ?? {};
        if (args.seat !== "seat_0000000000000000000000") {
          return reply(400, { status: "refused", reason: "invalid_seat" });
        }
        if (cmd.tool === "object_list") {
          if (accessMode === "refused") return reply(200, { status: "refused", reason: "workspace_access_refused" });
          if (accessMode === "consent") return reply(200, { status: "refused", reason: "content_consent_required" });
          const all = [...objects.values()].map((o) => ({
            object_id: o.object_id,
            kind: o.kind,
            title: o.title,
            revision: revRef(o),
          }));
          const offset = Number(args.offset || 0);
          const limit = forceObjectListPageSize ?? Math.min(Number(args.limit || 100), 100);
          const slice = all.slice(offset, offset + limit);
          const nextOffset = offset + slice.length < all.length ? offset + slice.length : null;
          return reply(200, { status: "ok", kind: "object_list", objects: slice, next_offset: nextOffset });
        }
        if (cmd.tool === "object_history") {
          if (accessMode === "refused") return reply(200, { status: "refused", reason: "workspace_access_refused" });
          if (accessMode === "consent") return reply(200, { status: "refused", reason: "content_consent_required" });
          const obj = objects.get(String(args.object_id || ""));
          if (!obj) return reply(200, { status: "refused", reason: "object_not_found" });
          const offset = Number(args.offset || 0);
          const limit = forceHistoryPageSize ?? Math.min(Number(args.limit || 50), 100);
          const slice = obj.revisions.slice(offset, offset + limit).map((r) => ({
            revision: r.revision,
            parent: r.parent,
            title: r.title,
            kind: r.kind,
            author: r.author,
            occurred_at_server: r.occurred_at_server,
            command_id: body.command_id,
            live: r.live ?? true,
          }));
          const nextOffset = offset + slice.length < obj.revisions.length ? offset + slice.length : null;
          return reply(200, { status: "ok", kind: "object_history", revisions: slice, next_offset: nextOffset });
        }
        if (cmd.tool === "object_read") {
          readCount += 1;
          if (failNextReadStatus !== null) {
            const code = failNextReadStatus;
            failNextReadStatus = null;
            return reply(code, { error: "unavailable" });
          }
          if (refuseNextReadReason !== null) {
            const reason = refuseNextReadReason;
            refuseNextReadReason = null;
            return reply(200, { status: "refused", reason });
          }
          if (accessMode === "refused") {
            return reply(200, { status: "refused", reason: "workspace_access_refused" });
          }
          if (accessMode === "consent") {
            return reply(200, { status: "refused", reason: "content_consent_required" });
          }
          const obj = objects.get(String(args.object_id || ""));
          if (!obj) return reply(200, { status: "refused", reason: "object_not_found" });
          let target = obj.revisions[0];
          if (args.revision?.token) {
            target = obj.revisions.find((r) => r.revision.token === args.revision.token);
            if (!target) return reply(200, { status: "refused", reason: "revision_not_found" });
          }
          return reply(200, {
            status: "ok",
            kind: "object_read",
            live: target.live ?? true,
            revision: {
              revision: target.revision,
              parent: target.parent,
              title: target.title,
              kind: target.kind,
              file_metadata: null,
              blob: { size_bytes: 256, sha256: "00".repeat(32) },
              author: target.author,
              occurred_at_server: target.occurred_at_server,
              command_id: body.command_id,
            },
            content: cloneContent(target.content),
          });
        }
        if (cmd.tool === "object_create") {
          receivedCreates.push({ command_id: body.command_id, arguments: args });
          if (failNextCreate) {
            failNextCreate = false;
            return reply(503, { error: "unavailable" });
          }
          if (accessMode === "refused") return reply(200, { status: "refused", reason: "workspace_access_refused" });
          if (accessMode === "consent") return reply(200, { status: "refused", reason: "content_consent_required" });
          if (accessMode === "reader") return reply(200, { status: "refused", reason: "content_read_only" });
          const objectId = String(args.object_id || "");
          const title = String(args.title || "").trim();
          const content = args.content;
          if (!objectId || !title || !content || (content.kind !== "list" && content.kind !== "doc")) {
            return reply(200, { status: "refused", reason: "invalid_request" });
          }
          if (objects.has(objectId)) {
            return reply(200, { status: "refused", reason: "object_exists" });
          }
          const initialRev = {
            revision: makeRevRef(objectId, `rev_${objectId}_1`),
            parent: null,
            title,
            kind: content.kind,
            author: { user_id: me, principal_id: null, run_id: null, connection_id: null, grant_id: null },
            occurred_at_server: Date.now(),
            live: true,
            content: content.kind === "list"
              ? { kind: "list", items: content.items ?? [] }
              : { kind: "doc", markdown: String(content.markdown ?? "") },
          };
          objects.set(objectId, {
            object_id: objectId,
            kind: content.kind,
            title,
            token: initialRev.revision.token,
            revCounter: 1,
            author: initialRev.author,
            occurred_at_server: initialRev.occurred_at_server,
            content: cloneContent(initialRev.content),
            revisions: [initialRev],
          });
          return reply(200, {
            status: "committed",
            object_id: objectId,
            revision: initialRev.revision,
            request_id: args.request_id,
            replayed: false,
          });
        }
        if (cmd.tool === "object_update") {
          receivedUpdates.push({ command_id: body.command_id, arguments: args });
          if (failNextUpdate) {
            failNextUpdate = false;
            return reply(503, { error: "unavailable" });
          }
          if (accessMode === "refused") return reply(200, { status: "refused", reason: "workspace_access_refused" });
          if (accessMode === "consent") return reply(200, { status: "refused", reason: "content_consent_required" });
          if (accessMode === "reader") {
            return reply(200, { status: "refused", reason: "content_read_only" });
          }
          const obj = objects.get(String(args.object_id || ""));
          if (!obj || (obj.kind !== "list" && obj.kind !== "doc")) {
            return reply(200, { status: "refused", reason: "object_not_found" });
          }
          const baseSnap = obj.revisions.find((r) => r.revision.token === args.base?.token);
          if (!baseSnap) {
            return reply(200, { status: "refused", reason: "revision_not_found" });
          }
          if (conflictNextUpdate) {
            conflictNextUpdate = false;
            const proposed = applyContentPatch(baseSnap.content, args.patch);
            if (!proposed) return reply(200, { status: "refused", reason: "patch_base_mismatch" });

            // Advance server state with a competing revision by Maya Chen
            const competingContent = obj.kind === "list"
              ? {
                  kind: "list",
                  items: [
                    ...obj.content.items.map((i) => ({ ...i })),
                    { item_id: "item_maya_competing", text: "Sourdough loaf (added by Maya)", order: obj.content.items.length, checked: false },
                  ],
                }
              : {
                  kind: "doc",
                  markdown: obj.content.markdown + "\n\n## Note from Maya\nConfirm release notes before upload.",
                };
            obj.revCounter += 1;
            const competingRev = {
              revision: makeRevRef(obj.object_id, `rev_${obj.object_id}_${obj.revCounter}`),
              parent: revRef(obj),
              title: obj.title,
              kind: obj.kind,
              author: { user_id: maya, principal_id: null, run_id: null, connection_id: null, grant_id: null },
              occurred_at_server: Date.now(),
              live: true,
              content: competingContent,
            };
            obj.token = competingRev.revision.token;
            obj.content = cloneContent(competingContent);
            obj.author = competingRev.author;
            obj.occurred_at_server = competingRev.occurred_at_server;
            obj.revisions.unshift(competingRev);

            draftCounter += 1;
            const draftId = `draft_conflict_${draftCounter}`;
            drafts.set(draftId, {
              workspace_id: wsMain,
              object_id: obj.object_id,
              draft_id: draftId,
              owner_user_id: me,
              proposed,
              base: baseSnap,
              current: competingRev,
            });
            return reply(409, {
              status: "conflict",
              object_id: obj.object_id,
              current: revRef(obj),
              draft_id: draftId,
              request_id: args.request_id,
              replayed: false,
            });
          }
          if (args.base?.token !== obj.token) {
            const proposed = applyContentPatch(baseSnap.content, args.patch);
            if (!proposed) return reply(200, { status: "refused", reason: "patch_base_mismatch" });
            draftCounter += 1;
            const draftId = `draft_stale_${draftCounter}`;
            drafts.set(draftId, {
              workspace_id: wsMain,
              object_id: obj.object_id,
              draft_id: draftId,
              owner_user_id: me,
              proposed,
              base: baseSnap,
              current: obj.revisions[0],
            });
            return reply(409, {
              status: "conflict",
              object_id: obj.object_id,
              current: revRef(obj),
              draft_id: draftId,
              request_id: args.request_id,
              replayed: false,
            });
          }
          const updatedContent = applyContentPatch(obj.content, args.patch);
          if (!updatedContent) {
            return reply(200, { status: "refused", reason: "patch_base_mismatch" });
          }
          obj.revCounter += 1;
          const nextRev = {
            revision: makeRevRef(obj.object_id, `rev_${obj.object_id}_${obj.revCounter}`),
            parent: revRef(obj),
            title: obj.title,
            kind: obj.kind,
            author: { user_id: me, principal_id: null, run_id: null, connection_id: null, grant_id: null },
            occurred_at_server: Date.now(),
            live: true,
            content: updatedContent,
          };
          obj.token = nextRev.revision.token;
          obj.content = cloneContent(updatedContent);
          obj.author = nextRev.author;
          obj.occurred_at_server = nextRev.occurred_at_server;
          obj.revisions.unshift(nextRev);
          return reply(200, {
            status: "committed",
            object_id: obj.object_id,
            revision: nextRev.revision,
            request_id: args.request_id,
            replayed: false,
          });
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
        return reply(200, [
          { user_id: me, display_name: "You" },
          { user_id: maya, display_name: "Maya Chen" },
        ]);
      case "/rest/v1/agent_principals":
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
    console.log(`SharedObjects fixture listening on loopback port ${actualPort}`);
    return;
  }
  const child = spawn(process.argv[3], [String(actualPort), ...process.argv.slice(4)], { stdio: "inherit" });
  child.once("error", () => { process.exitCode = 1; server.close(); });
  child.once("exit", (status) => {
    process.exitCode = status ?? 1;
    server.close();
  });
});

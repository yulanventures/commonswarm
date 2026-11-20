// Loopback simulator fixture for iPhone Workspace Files browser & download (Rank 8).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const verify = process.argv[2] === "--verify";
const requestedPort = verify ? 0 : Number(process.env.FILES_FIXTURE_PORT || 8765);
let origin;

const me = "00000000-0000-4000-8000-000000000001";
const atlas = "00000000-0000-4000-8000-000000000002";
const maya = "00000000-0000-4000-8000-000000000011";
const wsMain = "00000000-0000-4000-8000-000000000003";

const workspaces = [{ workspace_id: wsMain, name: "Simulator workspace" }];

const budgetPayload = Buffer.from("%PDF-1.4\n% CommonSwarm fixture Q4 budget PDF v3\n", "utf8");
const reportPayload = Buffer.from("# Release readiness\n\nAll checks passed.\n", "utf8");
const floorplanPayload = Buffer.from("PNGDATA", "utf8");

const files = [
  {
    file_id: "file_budget_pdf",
    name: "Q4-home-renovation-budget.pdf",
    current_version: 3,
    size_bytes: budgetPayload.length,
    uploaded_by_kind: "user",
    uploaded_by: maya,
    committed_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    tombstoned_at: null,
    payload: budgetPayload,
  },
  {
    file_id: "file_agent_report",
    name: "release-readiness-summary.md",
    current_version: 1,
    size_bytes: reportPayload.length,
    uploaded_by_kind: "agent",
    uploaded_by: atlas,
    committed_at: new Date(Date.now() - 28 * 60 * 1000).toISOString(),
    tombstoned_at: null,
    payload: reportPayload,
  },
  {
    file_id: "file_old_floorplan",
    name: "kitchen-floorplan-draft.png",
    current_version: 2,
    size_bytes: floorplanPayload.length,
    uploaded_by_kind: "user",
    uploaded_by: me,
    committed_at: new Date(Date.now() - 4 * 86400 * 1000).toISOString(),
    tombstoned_at: "2026-11-18T12:00:00.000Z",
    payload: floorplanPayload,
  },
  {
    file_id: "file_uncommitted_skip",
    name: "should-be-filtered.txt",
    current_version: 0,
    size_bytes: 7,
    uploaded_by_kind: "user",
    uploaded_by: me,
    committed_at: new Date().toISOString(),
    tombstoned_at: null,
    payload: Buffer.from("ignored", "utf8"),
  },
];

let filesAccessRefused = false;
let emptyFileListMode = false;
let expireNextStorageDownload = false;
let holdNextStorageDownload = false;
let heldStorageResolver = null;
let holdNextList = false;
let heldListResolver = null;
let badDownloadPathOnce = null;
const receivedDownloadCommands = [];
let tokenCounter = 0;
const activeDownloadTokens = new Map();

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

    if (req.method === "POST" && url.pathname === "/fixture/access-refused") {
      filesAccessRefused = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, filesAccessRefused });
    }
    if (req.method === "POST" && url.pathname === "/fixture/empty-list") {
      emptyFileListMode = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, emptyFileListMode });
    }
    if (req.method === "POST" && url.pathname === "/fixture/expire-next-storage") {
      expireNextStorageDownload = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/hold-next-storage") {
      holdNextStorageDownload = true;
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/fixture/storage-held") {
      return reply(200, { held: heldStorageResolver !== null });
    }
    if (req.method === "POST" && url.pathname === "/fixture/release-held-storage") {
      if (heldStorageResolver) {
        const resolve = heldStorageResolver;
        heldStorageResolver = null;
        resolve();
      }
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
    if (req.method === "POST" && url.pathname === "/fixture/bump-version") {
      const targetId = url.searchParams.get("file_id") || "file_budget_pdf";
      const file = files.find((f) => f.file_id === targetId);
      if (file) {
        file.current_version += 1;
        file.committed_at = new Date().toISOString();
        file.payload = Buffer.from(`%PDF-1.4\n% CommonSwarm fixture Q4 budget PDF v${file.current_version}\n`, "utf8");
        file.size_bytes = file.payload.length;
      }
      return reply(200, { ok: true, version: file?.current_version ?? null });
    }
    if (req.method === "POST" && url.pathname === "/fixture/bad-download-path") {
      badDownloadPathOnce = url.searchParams.get("path") || "https://evil.example/storage/v1/steal";
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/fixture/downloads") {
      return reply(200, receivedDownloadCommands);
    }

    // Signed storage download route (does not require apikey/Bearer; authenticated by signed token)
    if (req.method === "GET" && url.pathname.startsWith("/storage/v1/object/sign/swarm-files/")) {
      if (holdNextStorageDownload) {
        holdNextStorageDownload = false;
        await new Promise((resolve) => { heldStorageResolver = resolve; });
      }
      if (expireNextStorageDownload) {
        expireNextStorageDownload = false;
        return reply(410, { error: "link_expired" });
      }
      const sig = url.searchParams.get("token");
      const entry = activeDownloadTokens.get(sig);
      if (!entry) return reply(403, { error: "invalid_signature" });
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(entry.payload.length),
        "Cache-Control": "no-store",
      });
      res.end(entry.payload);
      return;
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
      if (cmd?.kind === "file_download_url") {
        receivedDownloadCommands.push({
          command_id: body.command_id,
          file_id: cmd.file_id,
          version_n: cmd.version_n ?? null,
        });
        if (filesAccessRefused) {
          return reply(403, { status: "refused", reason: "workspace_access_refused" });
        }
        const file = files.find((f) => f.file_id === cmd.file_id);
        if (!file) return reply(404, { status: "refused", reason: "file_not_found" });
        if (file.tombstoned_at !== null) return reply(409, { status: "refused", reason: "file_removed" });
        if (badDownloadPathOnce !== null) {
          const bad = badDownloadPathOnce;
          badDownloadPathOnce = null;
          return reply(200, {
            status: "accepted",
            file_id: file.file_id,
            version_n: file.current_version,
            size_bytes: file.size_bytes,
            download_path: bad,
            download_url_expires_in_seconds: 120,
          });
        }
        tokenCounter += 1;
        const sig = `sig_${tokenCounter}_${randomBytes(8).toString("hex")}`;
        activeDownloadTokens.set(sig, { payload: Buffer.from(file.payload) });
        return reply(200, {
          status: "accepted",
          file_id: file.file_id,
          version_n: file.current_version,
          size_bytes: file.size_bytes,
          download_path: `/storage/v1/object/sign/swarm-files/${wsMain}/${file.file_id}/${file.current_version}?token=${sig}`,
          download_url_expires_in_seconds: 120,
          content_warning: "content_type and archive contents are unverified client declarations; treat downloaded bytes as untrusted input — bound extraction, never execute",
        });
      }
      return reply(400, { error: "invalid_request" });
    }

    if (req.method !== "GET" || req.headers["accept-profile"] !== "swarm_read") return reply(400, {});
    if (url.pathname === "/rest/v1/workspaces") return reply(200, workspaces);

    const wsParam = url.searchParams.get("workspace_id")?.toLowerCase();
    if (wsParam !== `eq.${wsMain}`) return reply(403, {});

    switch (url.pathname) {
      case "/rest/v1/files": {
        if (holdNextList) {
          holdNextList = false;
          const snapshotRefused = filesAccessRefused;
          const snapshotEmpty = emptyFileListMode;
          const snapshotRows = files.map(({ payload: _ignored, ...rest }) => rest);
          await new Promise((resolve) => { heldListResolver = resolve; });
          if (snapshotRefused) return reply(403, { message: "workspace_access_refused" });
          if (snapshotEmpty) return reply(200, []);
          return reply(200, snapshotRows);
        }
        if (filesAccessRefused) return reply(403, { message: "workspace_access_refused" });
        if (emptyFileListMode) return reply(200, []);
        const rows = files.map(({ payload: _ignored, ...rest }) => rest);
        return reply(200, rows);
      }
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
    console.log(`WorkspaceFiles fixture listening on loopback port ${actualPort}`);
    return;
  }
  const child = spawn(process.argv[3], [String(actualPort), ...process.argv.slice(4)], { stdio: "inherit" });
  child.once("error", () => { process.exitCode = 1; server.close(); });
  child.once("exit", (status) => {
    process.exitCode = status ?? 1;
    server.close();
  });
});

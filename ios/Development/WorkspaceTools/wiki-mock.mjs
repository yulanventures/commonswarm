// Loopback verification fixture for iPhone Workspace Wiki (Rank 11).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const verify = process.argv[2] === "--verify";
const requestedPort = verify ? 0 : Number(process.env.WIKI_PORT || 8766);
let origin;

const me = "00000000-0000-4000-8000-000000000001";
const atlas = "00000000-0000-4000-8000-000000000002";
const maya = "00000000-0000-4000-8000-000000000011";
const wsMain = "00000000-0000-4000-8000-000000000003";

const workspaces = [{ workspace_id: wsMain, name: "Simulator workspace" }];

const fileChecklistID = "40000000-0000-4000-8000-000000000001";
const fileRoadmapID = "40000000-0000-4000-8000-000000000002";
const fileOtherID = "40000000-0000-4000-8000-000000000003";
const fileTombstonedID = "40000000-0000-4000-8000-000000000004";

const files = new Map();
const versionsByFile = new Map(); // fileID -> Map<versionN, { bytes: Buffer, state: 'live'|'retired', sha256: string }>
const pendingSlots = new Map(); // versionID -> { fileID, versionN, name, declaredSize, uploadedBytes: Buffer|null }
const createReceipts = new Map();
const commitReceipts = new Map();
const recordedCommands = [];
let commitMutations = 0;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const seed = () => {
  files.clear();
  versionsByFile.clear();
  pendingSlots.clear();

  const v1 = Buffer.from("# Release Checklist\n\nInitial checklist draft.\n", "utf8");
  const v2 = Buffer.from(
    "# Release Checklist\n\n- Run tests before shipping.\n- Check `roadmap` for upcoming milestones.\n- See https://example.com/?topic=release-checklist for notes.\n",
    "utf8",
  );
  files.set(fileChecklistID, {
    file_id: fileChecklistID,
    name: "brain--release-checklist.md",
    current_version: 2,
    size_bytes: v2.length,
    uploaded_by_kind: "user",
    uploaded_by: maya,
    committed_at: "2026-11-19T12:00:00.000Z",
    tombstoned_at: null,
  });
  versionsByFile.set(
    fileChecklistID,
    new Map([
      [1, { bytes: v1, state: "live", sha256: sha256(v1) }],
      [2, { bytes: v2, state: "live", sha256: sha256(v2) }],
    ]),
  );

  const roadmapV1 = Buffer.from("# Roadmap\n\nFollow release-checklist for every ship.\n", "utf8");
  files.set(fileRoadmapID, {
    file_id: fileRoadmapID,
    name: "brain--roadmap.md",
    current_version: 1,
    size_bytes: roadmapV1.length,
    uploaded_by_kind: "agent",
    uploaded_by: atlas,
    committed_at: "2026-11-19T11:30:00.000Z",
    tombstoned_at: null,
  });
  versionsByFile.set(
    fileRoadmapID,
    new Map([[1, { bytes: roadmapV1, state: "live", sha256: sha256(roadmapV1) }]]),
  );

  // Ordinary non-wiki file (must NOT appear in wiki topics)
  files.set(fileOtherID, {
    file_id: fileOtherID,
    name: "budget.pdf",
    current_version: 1,
    size_bytes: 1024,
    uploaded_by_kind: "user",
    uploaded_by: maya,
    committed_at: "2026-11-19T10:00:00.000Z",
    tombstoned_at: null,
  });

  // Tombstoned brain file (must NOT appear in wiki topics)
  files.set(fileTombstonedID, {
    file_id: fileTombstonedID,
    name: "brain--archived-note.md",
    current_version: 1,
    size_bytes: 32,
    uploaded_by_kind: "user",
    uploaded_by: maya,
    committed_at: "2026-11-18T10:00:00.000Z",
    tombstoned_at: "2026-11-19T09:00:00.000Z",
  });
};
seed();

let contentRole = "editor"; // editor | reader
let edge403Mode = false;
let edge401Mode = false;
let commitThen503 = false;
let create503Once = false;
let preReceiptRefusalReason = null;
let expireNextDownload = false;
let duplicateDirectory = false;
let putCount = 0;

const operationsForRole = (role) => (role === "editor" ? ["read", "create", "update"] : ["read"]);

let emailCodePending = false;
const sessions = new Set();

const server = createServer(async (req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  };
  try {
    const url = new URL(req.url, origin);
    if (req.headers.host !== new URL(origin).host) return reply(400, {});

    // Fixture controls
    if (req.method === "POST" && url.pathname === "/fixture/content-role") {
      contentRole = url.searchParams.get("role") || "editor";
      return reply(200, { ok: true, contentRole });
    }
    if (req.method === "POST" && url.pathname === "/fixture/edge-403") {
      edge403Mode = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, edge403Mode });
    }
    if (req.method === "POST" && url.pathname === "/fixture/edge-401") {
      edge401Mode = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, edge401Mode });
    }
    if (req.method === "POST" && url.pathname === "/fixture/commit-then-503") {
      commitThen503 = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/create-503-once") {
      create503Once = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/replace-topic") {
      const fid = url.searchParams.get("file_id");
      const replacementID = url.searchParams.get("replacement_id") || randomUUID();
      const old = fid ? files.get(fid) : null;
      if (!old) return reply(404, { ok: false });
      const replacementBody = Buffer.from(`# Replacement ${old.name}\n\nFresh page at v${old.current_version}.\n`, "utf8");
      files.delete(fid);
      versionsByFile.delete(fid);
      files.set(replacementID, {
        file_id: replacementID,
        name: old.name,
        current_version: old.current_version,
        size_bytes: replacementBody.length,
        uploaded_by_kind: "user",
        uploaded_by: maya,
        committed_at: new Date().toISOString(),
        tombstoned_at: null,
      });
      versionsByFile.set(
        replacementID,
        new Map([[old.current_version, { bytes: replacementBody, state: "live", sha256: sha256(replacementBody) }]]),
      );
      return reply(200, { ok: true, replacement_id: replacementID, version: old.current_version });
    }
    if (req.method === "POST" && url.pathname === "/fixture/pre-receipt-refusal") {
      const r = url.searchParams.get("reason");
      preReceiptRefusalReason = r && r.length > 0 ? r : null;
      return reply(200, { ok: true, preReceiptRefusalReason });
    }
    if (req.method === "POST" && url.pathname === "/fixture/expire-next-download") {
      expireNextDownload = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/duplicate-directory") {
      duplicateDirectory = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, duplicateDirectory });
    }
    if (req.method === "POST" && url.pathname === "/fixture/advance-version") {
      const fid = url.searchParams.get("file_id") || fileChecklistID;
      const f = files.get(fid);
      if (!f) return reply(404, { ok: false });
      const nextV = f.current_version + 2;
      const body = Buffer.from(`# Updated externally to v${nextV}\n\nExternal edit.\n`, "utf8");
      f.current_version = nextV;
      f.size_bytes = body.length;
      f.committed_at = new Date().toISOString();
      const map = versionsByFile.get(fid) ?? new Map();
      map.set(nextV, { bytes: body, state: "live", sha256: sha256(body) });
      versionsByFile.set(fid, map);
      return reply(200, { ok: true, version: nextV });
    }
    if (req.method === "POST" && url.pathname === "/fixture/delete-topic") {
      const fid = url.searchParams.get("file_id") || fileRoadmapID;
      const f = files.get(fid);
      if (!f) return reply(404, { ok: false });
      f.tombstoned_at = new Date().toISOString();
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/fixture/commands") {
      return reply(200, recordedCommands);
    }
    if (req.method === "GET" && url.pathname === "/fixture/mutations") {
      return reply(200, { commits: commitMutations, puts: putCount });
    }

    // Signed storage upload PUT (no apikey/bearer; token query authenticates)
    if (req.method === "PUT" && url.pathname.startsWith("/storage/v1/object/upload/sign/swarm-files/")) {
      putCount += 1;
      const tokenParam = url.searchParams.get("token");
      if (!tokenParam || !pendingSlots.has(tokenParam)) return reply(403, { error: "invalid_upload_token" });
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const slot = pendingSlots.get(tokenParam);
      slot.uploadedBytes = raw;
      return reply(200, { ok: true });
    }

    // Signed storage download GET (no apikey/bearer; token query authenticates)
    if (req.method === "GET" && url.pathname.startsWith("/storage/v1/object/sign/swarm-files/")) {
      if (expireNextDownload) {
        expireNextDownload = false;
        res.writeHead(410, { "Content-Type": "text/plain" });
        return res.end("expired");
      }
      const parts = url.pathname.split("/");
      const fid = parts[parts.length - 2];
      const ver = Number(parts[parts.length - 1]);
      const vmap = versionsByFile.get(fid);
      const entry = vmap?.get(ver);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found");
      }
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Length": String(entry.bytes.length),
        "Cache-Control": "no-store",
      });
      return res.end(entry.bytes);
    }

    if (req.headers.apikey !== "local-fixture") return reply(401, {});

    let body;
    if (req.method === "POST") {
      let data = "";
      for await (const chunk of req) {
        data += chunk;
        if (data.length > 131_072) return reply(413, {});
      }
      body = data ? JSON.parse(data) : {};
    }

    if (req.method === "POST" && url.pathname === "/auth/v1/otp") {
      emailCodePending = true;
      return reply(200, {});
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/verify") {
      if (!emailCodePending) return reply(403, {});
      emailCodePending = false;
      const access = randomBytes(32).toString("hex");
      sessions.add(access);
      return reply(200, { access_token: access, refresh_token: randomBytes(32).toString("hex"), expires_in: 3600, user: { id: me } });
    }

    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!sessions.has(token)) return reply(401, {});
    if (edge401Mode) return reply(401, {});
    if (edge403Mode) return reply(403, { error: "forbidden" });

    if (req.method === "POST" && url.pathname === "/functions/v1/command") {
      const cmd = body.command;
      if (cmd?.kind === "household_access") {
        return reply(200, { status: "ok", content_role: contentRole, operations: operationsForRole(contentRole) });
      }

      if (cmd?.kind === "file_download_url") {
        recordedCommands.push({ command_id: body.command_id, kind: cmd.kind, file_id: cmd.file_id, version_n: cmd.version_n });
        const f = files.get(cmd.file_id);
        if (!f) return reply(404, { status: "refused", reason: "file_not_found" });
        if (f.tombstoned_at) return reply(409, { status: "refused", reason: "file_tombstoned" });
        const v = cmd.version_n ?? f.current_version;
        const entry = versionsByFile.get(cmd.file_id)?.get(v);
        if (!entry) return reply(404, { status: "refused", reason: "file_not_found" });
        const dlPath = `/storage/v1/object/sign/swarm-files/${wsMain}/${cmd.file_id}/${v}?token=dl-${randomUUID()}`;
        return reply(200, {
          status: "accepted",
          file_id: cmd.file_id,
          version_n: v,
          version_state: entry.state,
          size_bytes: entry.bytes.length,
          download_path: dlPath,
          download_url_expires_in_seconds: 300,
        });
      }

      if (cmd?.kind === "file_version_create") {
        recordedCommands.push({ command_id: body.command_id, kind: cmd.kind, file_id: cmd.file_id, if_version: cmd.if_version });
        if (create503Once) {
          create503Once = false;
          return reply(503, { error: "unavailable" });
        }
        if (preReceiptRefusalReason) {
          const r = preReceiptRefusalReason;
          preReceiptRefusalReason = null;
          return reply(403, { status: "refused", reason: r });
        }
        const ops = operationsForRole(contentRole);
        const needed = cmd.if_version > 0 ? "update" : "create";
        if (!ops.includes(needed)) return reply(403, { status: "refused", reason: "content_read_only" });
        if (createReceipts.has(body.command_id)) {
          return reply(200, createReceipts.get(body.command_id));
        }
        const existing = Array.from(files.values()).find((x) => x.name.toLowerCase() === cmd.name.toLowerCase() && !x.tombstoned_at);
        const liveVersion = existing ? existing.current_version : 0;
        if (cmd.if_version !== null && cmd.if_version !== undefined && cmd.if_version !== liveVersion) {
          return reply(409, { status: "refused", reason: "file_version_precondition_failed", current_version: liveVersion });
        }
        const targetFileID = existing ? existing.file_id : cmd.file_id;
        const nextVersion = liveVersion + 1;
        pendingSlots.set(cmd.version_id, {
          fileID: targetFileID,
          versionN: nextVersion,
          name: cmd.name,
          declaredSize: cmd.declared_size_bytes,
          ifVersion: cmd.if_version,
          uploadedBytes: null,
        });
        const uploadPath = `/storage/v1/object/upload/sign/swarm-files/${wsMain}/${targetFileID}/${nextVersion}?token=${cmd.version_id}`;
        const receipt = {
          status: "accepted",
          file_id: targetFileID,
          version_id: cmd.version_id,
          version_n: nextVersion,
          upload_path: uploadPath,
        };
        createReceipts.set(body.command_id, receipt);
        return reply(200, receipt);
      }

      if (cmd?.kind === "file_version_commit") {
        recordedCommands.push({ command_id: body.command_id, kind: cmd.kind, file_id: cmd.file_id, version_id: cmd.version_id });
        if (preReceiptRefusalReason) {
          const r = preReceiptRefusalReason;
          preReceiptRefusalReason = null;
          return reply(403, { status: "refused", reason: r });
        }
        const ops = operationsForRole(contentRole);
        if (!ops.includes("update") && !ops.includes("create")) {
          return reply(403, { status: "refused", reason: "content_read_only" });
        }
        if (commitReceipts.has(body.command_id)) {
          return reply(200, { ...commitReceipts.get(body.command_id), replayed: true });
        }
        const slot = pendingSlots.get(cmd.version_id);
        if (!slot || !slot.uploadedBytes) return reply(404, { status: "refused", reason: "file_not_found" });
        if (cmd.sha256 && sha256(slot.uploadedBytes) !== cmd.sha256) {
          return reply(400, { status: "refused", reason: "sha256_mismatch" });
        }
        const existing = files.get(slot.fileID);
        const liveVersion = existing ? existing.current_version : 0;
        if (slot.ifVersion !== null && slot.ifVersion !== undefined && slot.ifVersion !== liveVersion) {
          return reply(409, { status: "refused", reason: "file_version_precondition_failed", current_version: liveVersion });
        }
        const now = new Date().toISOString();
        const committedVersion = liveVersion + 1;
        files.set(slot.fileID, {
          file_id: slot.fileID,
          name: slot.name,
          current_version: committedVersion,
          size_bytes: slot.uploadedBytes.length,
          uploaded_by_kind: "user",
          uploaded_by: me,
          committed_at: now,
          tombstoned_at: null,
        });
        const vmap = versionsByFile.get(slot.fileID) ?? new Map();
        vmap.set(committedVersion, { bytes: slot.uploadedBytes, state: "live", sha256: sha256(slot.uploadedBytes) });
        versionsByFile.set(slot.fileID, vmap);
        commitMutations += 1;
        const receipt = {
          status: "accepted",
          file_id: slot.fileID,
          version_n: committedVersion,
          size_bytes: slot.uploadedBytes.length,
          replayed: false,
        };
        commitReceipts.set(body.command_id, receipt);
        if (commitThen503) {
          commitThen503 = false;
          return reply(503, { error: "unavailable" });
        }
        return reply(200, receipt);
      }

      return reply(400, { error: "invalid_request" });
    }

    if (req.method !== "GET" || req.headers["accept-profile"] !== "swarm_read") return reply(400, {});
    if (url.pathname === "/rest/v1/workspaces") return reply(200, workspaces);
    if (url.pathname === "/rest/v1/files") return reply(200, Array.from(files.values()));
    if (url.pathname === "/rest/v1/member_profiles") {
      const rows = [
        { user_id: me, display_name: "You" },
        { user_id: maya, display_name: "Maya Chen" },
      ];
      if (duplicateDirectory) rows.push({ user_id: maya, display_name: "Maya Chen" });
      return reply(200, rows);
    }
    if (url.pathname === "/rest/v1/agent_principals") {
      const rows = [{ principal_id: atlas, name: "Atlas" }];
      if (duplicateDirectory) rows.push({ principal_id: atlas, name: "Atlas" });
      return reply(200, rows);
    }
    return reply(404, {});
  } catch {
    return reply(400, {});
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  const actualPort = server.address().port;
  origin = `http://127.0.0.1:${actualPort}`;
  if (!verify) {
    console.log(`Wiki fixture listening on loopback port ${actualPort}`);
    return;
  }
  const child = spawn(process.argv[3], [String(actualPort), ...process.argv.slice(4)], { stdio: "inherit" });
  child.once("error", () => { process.exitCode = 1; server.close(); });
  child.once("exit", (status) => {
    process.exitCode = status ?? 1;
    server.close();
  });
});

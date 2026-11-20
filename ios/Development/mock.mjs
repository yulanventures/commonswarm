// Simulator fixture. All state is synthetic and disappears when the process exits.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const { client_version: expectedClientVersion } = JSON.parse(
  readFileSync(new URL("./post-agent.json", import.meta.url), "utf8"),
);
let origin;
const callbacks = new Map([
  ["github", "com.commonswarm.ios://auth/callback"],
  ["google", "https://commonswarm.com/ios/auth/callback"],
]);
const me = "00000000-0000-4000-8000-000000000001";
const agent = "00000000-0000-4000-8000-000000000002";
const workspace = "00000000-0000-4000-8000-000000000003";
const channel = "00000000-0000-4000-8000-000000000004";
const secondWorkspace = "00000000-0000-4000-8000-000000000005";
const longChannel = "00000000-0000-4000-8000-000000000006";
const verify = process.argv[2] === "--verify";
const upgrade = process.argv[2] === "--upgrade";
const conversationsEnabled = verify || process.argv[2] === "--conversations";
const review = conversationsEnabled || upgrade || process.argv[2] === "--review";
const workspaces = [{ workspace_id: workspace, name: "Simulator workspace" }];
const channels = [{ channel_id: channel, slug: "mobile", visibility: "open" }];
if (review) {
  workspaces.push({ workspace_id: secondWorkspace, name: "Second workspace" });
  channels.push({ channel_id: longChannel, slug: "engineering-release-coordination", visibility: "private" });
}
let olderPageInterrupted = false;
const codes = new Map();
let emailCodePending = false;
const emailWire = {};
const conversationWire = new Map();
let threadReplyWire;
// Record the actual Swift request, with stable key order for the CI fixture.
function recordEmailRequest(url, body) {
  if (verify) emailWire[url.pathname] = Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
}
const receipts = new Map();
const uploads = new Map();
const fileReceipts = new Map();
const refuseNextLookup = new Set();
const sessions = new Set();
const refreshTokens = new Set();
let refreshAttempts = 0;
let heldPost;
let notifyPost;
const postReceived = new Promise(resolve => { notifyPost = resolve; });
let authenticatedRequests = 0;
const messages = [];
const file = "00000000-0000-4000-8000-000000000009";
const fileBytes = Buffer.from("Workspace notes");
const signedPath = "/storage/v1/object/sign/swarm-files/" + workspace + "/" + file + "/2";
const fixtureFile = { file_id: file, version_n: 2, name: "Notes.txt", content_type: "text/plain", size_bytes: fileBytes.length };

const members = [{ kind: "user", id: me, name: "You" }, { kind: "agent", id: agent, name: "Atlas" }];
let capabilityProbeReads = 0;
let probeLegacyRequests = 0;
const capabilityProbe = "00000000-0000-4000-8000-000000000091";
const teammate = { kind: "user", id: "00000000-0000-4000-8000-000000000088", name: "Morgan" };
const twins = ["012345ab-0000-4000-8000-000000000001", "012345cd-0000-4000-8000-000000000002"]
  .map(id => ({ kind: "agent", id, name: "Riley" }));
const threadRows = [
  { conversation_id: "00000000-0000-4000-8000-000000000020", kind: "general", slug: "general", joined: true },
  { conversation_id: "00000000-0000-4000-8000-000000000021", kind: "public_channel", channel_id: channel, slug: "mobile", joined: true, members: [members[0]] },
  { conversation_id: "00000000-0000-4000-8000-000000000022", kind: "private_channel", channel_id: longChannel, slug: "design", joined: true, members: [members[0]] },
  { conversation_id: "00000000-0000-4000-8000-000000000023", kind: "public_channel", channel_id: randomUUID(), slug: "garden", joined: false },
  { conversation_id: "00000000-0000-4000-8000-000000000024", kind: "dm", joined: true, members, mention_count: 103 }
];
const address = (command) => command.conversation_id?.toLowerCase() ?? (command.channel ? command.expected_channel_id : command.to_agent_principal_id ? "direct" : "general");
if (review) {
  for (let i = 130; i > 0; i--) {
    messages.push({ id: randomUUID(), from: me, from_kind: "user", body: "History message " + i,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString().replace("Z", "+00:00"), fixtureDestination: "general", workspace });
  }
  messages[0].attachments = [fixtureFile];
}
if (process.argv[2] === "--conversations") {
  const group = { conversation_id: randomUUID(), kind: "group_dm", joined: true, members: [...members, teammate] };
  threadRows.push(group);
  for (const [body, audience] of [["Group topic", "conversation"], ["Restricted topic", "addressed"]]) {
    messages.push({ id: randomUUID(), from: me, from_kind: "user", body, audience, recipients: [members[1]],
      created_at: new Date().toISOString(), fixtureDestination: group.conversation_id, workspace });
  }
  for (const [index, body] of ["First topic", "Other topic"].entries()) {
    messages.unshift({ id: randomUUID(), from: me, from_kind: "user", body,
      created_at: new Date(Date.UTC(2026, 0, 2, 0, index)).toISOString(), fixtureDestination: channel, workspace });
  }
}
const privateCheck = { conversation_id: randomUUID(), kind: "private_channel", channel_id: randomUUID(), slug: "access-check", joined: true };
if (verify) threadRows.push(privateCheck);
let privateDenied = false;
let threadPosts = 0;
let holdNextMembershipRead = false;
const membershipReadHeld = Promise.withResolvers();
const releaseMembershipRead = Promise.withResolvers();
let memberWrites = 0;
let loseMemberReply = false;
const server = createServer(async (req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  };
  try {
    const url = new URL(req.url, origin);
    if (req.headers.host !== new URL(origin).host) return reply(400, {});
    if (req.method === "PUT" && url.pathname.startsWith("/storage/v1/object/upload/sign/swarm-files/")) {
      const slot = uploads.get(url.searchParams.get("token"));
      if (!slot || slot.path !== url.pathname || req.headers.authorization || req.headers.apikey || req.headers.cookie ||
          req.headers["content-type"] !== slot.type) return reply(403, {});
      if (slot.digest) return reply(409, {});
      const hash = createHash("sha256");
      let length = 0;
      for await (const part of req) { length += part.length; hash.update(part); }
      if (length !== slot.size) return reply(400, {});
      slot.digest = hash.digest("hex");
      return reply(200, {});
    }
    if (upgrade && req.method === "GET" && url.pathname === "/fixture/upgrade-stage") {
      return reply(200, refreshAttempts === 4 ? "complete" : sessions.size ? "restore" : "sign-in");
    }
    if (verify && req.method === "GET" && url.pathname.startsWith("/fixture/")) {
      if (url.pathname === "/fixture/hold-membership") { holdNextMembershipRead = true; return reply(200, 0); }
      if (url.pathname === "/fixture/membership-held") { await membershipReadHeld.promise; return reply(200, 0); }
      if (url.pathname === "/fixture/resume-membership") { releaseMembershipRead.resolve(); return reply(200, 0); }
      if (url.pathname === "/fixture/probe-legacy-requests") return reply(200, probeLegacyRequests);
      if (url.pathname === "/fixture/lose-member-reply") { loseMemberReply = true; return reply(200, memberWrites); }
      if (url.pathname === "/fixture/member-writes") return reply(200, memberWrites);
      if (url.pathname === "/fixture/lose-public") {
        threadRows.find(r => r.slug === "garden").joined = false;
        return reply(200, threadPosts);
      }
      if (url.pathname === "/fixture/deny-private") { privateDenied = true; return reply(200, threadPosts); }
      if (url.pathname === "/fixture/thread-posts") return reply(200, threadPosts);
      if (url.pathname === "/fixture/wait-for-post") {
        await postReceived;
      } else if (url.pathname === "/fixture/release") {
        heldPost?.();
      } else if (url.pathname !== "/fixture/count") return reply(404, {});
      return reply(200, authenticatedRequests);
    }
    if (req.method === "GET" && url.pathname === "/auth/v1/authorize") {
      const provider = url.searchParams.get("provider");
      const callback = provider === "google" && process.env.CS_FIXTURE_GOOGLE_USB === "1"
        ? "commonswarm://auth/callback" : callbacks.get(provider);
      if (!callback) return reply(400, {});
      const redirect = new URL(url.searchParams.get("redirect_to"));
      const state = redirect.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      if (!/^[a-f0-9]{64}$/.test(state ?? "") || redirect.href !== callback + "?state=" + state ||
          url.searchParams.get("code_challenge_method") !== "s256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge ?? "")) return reply(400, {});
      const code = randomUUID();
      codes.set(code, { challenge, expires: Date.now() + 60_000 });
      redirect.searchParams.set("code", code);
      res.writeHead(302, { Location: redirect.href, "Cache-Control": "no-store" });
      return res.end();
    }
    let body;
    if (req.method === "POST") {
      let data = "";
      for await (const chunk of req) {
        data += chunk;
        if (data.length > 65_536) return reply(413, {});
      }
      body = JSON.parse(data);
    }
    if (req.method === "GET" && url.pathname === signedPath && url.searchParams.get("token") === "fixture") {
      if (req.headers.apikey || req.headers.authorization) return reply(403, {});
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": fileBytes.length });
      return res.end(fileBytes);
    }
    if (req.headers.apikey !== "local-fixture") return reply(401, {});
    const issueSession = () => {
      const session = randomBytes(32).toString("hex");
      sessions.add(session);
      const refresh = randomBytes(32).toString("hex");
      refreshTokens.add(refresh);
      return reply(200, { access_token: session, refresh_token: refresh, expires_in: 3600, user: { id: me } });
    };
    if (req.method === "POST" && url.pathname === "/auth/v1/otp") {
      if (body.create_user !== false || url.search) return reply(400, {});
      if (body.email !== "reader@example.test") return reply(422, { code: 422, error_code: "otp_disabled" });
      recordEmailRequest(url, body);
      emailCodePending = true;
      return reply(200, {});
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/verify") {
      if (!emailCodePending || body.email !== "reader@example.test" || body.token !== "012345" || body.type !== "email" || url.search) {
        return reply(403, {});
      }
      recordEmailRequest(url, body);
      emailCodePending = false;
      return issueSession();
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      const pending = codes.get(body.auth_code);
      if (!pending || pending.expires <= Date.now() || typeof body.code_verifier !== "string" ||
          createHash("sha256").update(body.code_verifier).digest("base64url") !== pending.challenge) return reply(400, {});
      codes.delete(body.auth_code);
      return issueSession();
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      if (!refreshTokens.has(body.refresh_token)) return reply(400, { error_code: "refresh_token_not_found" });
      if (upgrade && ++refreshAttempts === 2) {
        return reply(503, {});
      }
      refreshTokens.delete(body.refresh_token);
      return issueSession();
    }
    if (!sessions.has((req.headers.authorization ?? "").replace(/^Bearer /, ""))) return reply(401, {});
    authenticatedRequests++;
    if (req.method === "POST" && url.pathname === "/functions/v1/read") {
      const ws = body.workspace_id?.toLowerCase();
      if (verify && ws === capabilityProbe) {
        capabilityProbeReads++;
        if (capabilityProbeReads === 1) return reply(200, { conversations: [] });
        if (capabilityProbeReads === 2) return reply(404, { error: "forbidden" });
        return reply(400, { error: "invalid_request" });
      }
      if (!conversationsEnabled || ws === secondWorkspace) return reply(400, { error: "invalid_request" });
      if (ws !== workspace) return reply(403, { error: "forbidden" });
      if (body.resource === "conversations" && body.include_archived === false) {
        if (verify && holdNextMembershipRead) {
          holdNextMembershipRead = false;
          const snapshot = structuredClone(threadRows);
          membershipReadHeld.resolve();
          await releaseMembershipRead.promise;
          return reply(200, { conversations: snapshot });
        }
        return reply(200, { conversations: threadRows });
      }
      const row = threadRows.find(r => r.conversation_id === body.conversation_id?.toLowerCase());
      if (body.resource !== "conversation_history" || !row) return reply(404, { error: "conversation_not_found" });
      if (row === privateCheck) {
        if (privateDenied) return reply(404, { error: "conversation_not_found" });
        return reply(200, { conversation: row, messages: [messages[0]] });
      }
      const targets = [row.conversation_id, row.kind === "general" ? "general" : row.channel_id];
      const history = messages.filter(m => targets.includes(m.fixtureDestination) && m.workspace === ws &&
        (!body.before_created_at || m.created_at < body.before_created_at ||
          (m.created_at === body.before_created_at && m.id < body.before_id.toLowerCase())));
      return reply(200, { conversation: row, messages: history.slice(0, body.limit).reverse().map(m => ({ audience: "conversation", ...m })) });
    }
    if (req.method === "POST" && url.pathname === "/functions/v1/command") {
      if (typeof body.client_version !== "string" || body.client_version !== expectedClientVersion) {
        if (verify) console.error("Invalid client_version for", body.command?.kind);
        return reply(400, { error: "invalid_request" });
      }
      if (body.command?.kind === "file_download_url" && body.workspace_id?.toLowerCase() === workspace &&
          body.command.file_id?.toLowerCase() === file && body.command.version_n === 2) {
        return reply(200, { ...fixtureFile, status: "accepted", download_path: signedPath + "?token=fixture" });
      }
      const cmd = body.command;
      if (cmd?.kind === "post_signal" && cmd.conversation_id) threadPosts++;
      if (verify && ["conversation_join", "conversation_open", "conversation_invite", "conversation_remove"].includes(cmd?.kind)) {
        if (cmd.kind !== "conversation_open" || cmd.members.length > 1) conversationWire.set(cmd.kind, cmd);
      }
      if (cmd?.kind === "conversation_open" && body.workspace_id?.toLowerCase() === workspace) {
        const candidates = [...members, teammate, ...twins];
        const refs = [members[0], ...cmd.members.map(m => candidates.find(c => c.id === m.id.toLowerCase() && c.kind === m.kind))];
        if (refs.some(m => !m)) return reply(400, {});
        const unique = [...new Set(refs)];
        const same = threadRows.find(r => r.kind.endsWith("dm") && r.members.length === unique.length &&
          unique.every(m => r.members.includes(m)));
        const thread = same ?? { conversation_id: randomUUID(), kind: unique.length > 2 ? "group_dm" : "dm",
          members: unique, joined: true };
        if (!same) threadRows.push(thread);
        return reply(200, { status: "accepted", conversation: thread });
      }
      if (["conversation_invite", "conversation_remove", "channel_member_add", "channel_member_remove"].includes(cmd?.kind)) {
        if (body.workspace_id?.toLowerCase() !== workspace) return reply(403, {});
        const isPrivate = cmd.kind.startsWith("channel_member_");
        const target = threadRows.find(r => isPrivate
          ? r.kind === "private_channel" && r.channel_id === cmd.channel_id?.toLowerCase()
          : r.kind === "public_channel" && r.conversation_id === cmd.conversation_id?.toLowerCase());
        if (!target || !target.joined) return reply(403, {});
        if (cmd.members) {
          for (const ref of cmd.members) {
            const person = [...members, teammate, ...twins].find(m => m.kind === ref.kind && m.id === ref.id.toLowerCase());
            if (!person) return reply(400, {});
            if (!target.members.includes(person)) target.members.push(person);
          }
        } else {
          target.members = target.members.filter(m => m.kind !== cmd.member.kind || m.id !== cmd.member.id.toLowerCase());
        }
        memberWrites++;
        if (loseMemberReply) { loseMemberReply = false; return reply(503, {}); }
        return reply(200, isPrivate ? { status: "accepted" } : { status: "accepted", conversation_id: target.conversation_id });
      }
      if (cmd?.kind === "conversation_join" && body.workspace_id?.toLowerCase() === workspace) {
        const target = threadRows.find(r => r.conversation_id === cmd.conversation_id.toLowerCase() && r.kind === "public_channel");
        if (!target) return reply(404, {});
        target.joined = true;
        return reply(200, { status: "accepted", conversation_id: target.conversation_id });
      }
      if (body.workspace_id?.toLowerCase() === workspace && ["file_version_create", "file_version_commit"].includes(cmd?.kind)) {
        if (fileReceipts.has(body.command_id)) return reply(200, fileReceipts.get(body.command_id));
        if (cmd.kind === "file_version_create") {
          if (uploads.has(cmd.version_id)) return reply(409, {});
          const path = "/storage/v1/object/upload/sign/swarm-files/" + workspace + "/" + cmd.file_id.toLowerCase() + "/1";
          uploads.set(cmd.version_id, { id: cmd.file_id, name: cmd.name, path, type: cmd.content_type, size: cmd.declared_size_bytes });
          const receipt = { status: "accepted", file_id: cmd.file_id, version_id: cmd.version_id, version_n: 1,
            upload_path: path + "?token=" + cmd.version_id };
          fileReceipts.set(body.command_id, receipt);
          return reply(200, receipt);
        }
        const slot = uploads.get(cmd.version_id);
        if (!slot || slot.id !== cmd.file_id || slot.digest !== cmd.sha256) return reply(409, {});
        const receipt = { status: "accepted", file_id: slot.id, version_n: 1, size_bytes: slot.size };
        fileReceipts.set(body.command_id, receipt);
        return reply(verify ? 503 : 200, verify ? {} : receipt);
      }
      if (!workspaces.some(row => row.workspace_id === body.workspace_id?.toLowerCase()) || body.command?.kind !== "post_signal") return reply(400, {});
      if (verify && body.command.body === "held during sign-out") {
        notifyPost();
        await new Promise(resolve => { heldPost = resolve; });
      }
      if (body.command.channel && !channels.some(row => row.slug === body.command.channel && row.channel_id === body.command.expected_channel_id)) return reply(404, {});
      if (refuseNextLookup.delete(body.command_id)) return reply(403, {});
      const attachments = [];
      for (const ref of cmd.attachments ?? []) {
        const file = [...uploads.values()].find(f => f.id === ref.file_id && f.digest && ref.version_n === 1);
        if (!file) return reply(400, {});
        attachments.push({ file_id: file.id, version_n: ref.version_n, name: file.name,
          content_type: file.type, size_bytes: file.size });
      }
      if (cmd.thread_root_id) {
        const root = messages.find(m => m.id === cmd.thread_root_id);
        const conversation = threadRows.find(r => r.conversation_id === address(cmd));
        if (!root || root.thread_root_id || root.workspace !== workspace ||
            !(root.fixtureDestination === address(cmd) || (conversation?.channel_id && root.fixtureDestination === conversation.channel_id))) {
          return reply(404, { error: "thread_root_not_found" });
        }
      }
      if (verify && cmd.body === "Thread receipt lost") threadReplyWire = cmd;
      const old = receipts.get(body.command_id);
      if (old && JSON.stringify(old.command, Object.keys(old.command).sort()) !== JSON.stringify(body.command, Object.keys(body.command).sort())) return reply(409, {});
      if (!old) {
        const id = verify && cmd.body === "Canonical DM" ? "00000000-0000-4000-8000-000000000092" : randomUUID();
        messages.unshift({ id, from: me, from_kind: "user", body: body.command.body, attachments, thread_root_id: cmd.thread_root_id ?? null,
          created_at: new Date().toISOString(), fixtureDestination: address(body.command), workspace: body.workspace_id.toLowerCase() });
        receipts.set(body.command_id, { command: body.command, signal: messages[0] });
        if (review && cmd.body === "Thread receipt lost") return reply(503, {});
        if (review && body.command.body === "Uncertain send") {
          refuseNextLookup.add(body.command_id);
          return reply(503, {});
        }
      }
      return reply(200, { status: "accepted", signal: receipts.get(body.command_id).signal });
    }
    if (url.pathname.startsWith("/rest/v1/") && url.searchParams.get("workspace_id")?.toLowerCase() === "eq." + capabilityProbe) {
      probeLegacyRequests++;
    }
    if (req.method !== "GET" || req.headers["accept-profile"] !== "swarm_read") return reply(400, {});
    if (url.pathname === "/rest/v1/workspaces") return reply(200, workspaces);
    const ws = workspaces.find(row => "eq." + row.workspace_id === url.searchParams.get("workspace_id")?.toLowerCase());
    if (!ws) return reply(403, {});
    switch (url.pathname) {
      case "/rest/v1/channels": {
        const filter = url.searchParams.get("channel_id");
        return reply(200, ws.workspace_id === workspace ? channels.filter(c => !filter || "eq." + c.channel_id === filter.toLowerCase()) : []);
      }
      case "/rest/v1/member_profiles": return reply(200, [{ user_id: me, display_name: "You" }, ...(conversationsEnabled ? [{ user_id: teammate.id, display_name: teammate.name }] : [])]);
      case "/rest/v1/agent_principals": return reply(200, [{ principal_id: agent, name: "Atlas" }, ...(conversationsEnabled ? twins.map(m => ({ principal_id: m.id, name: m.name })) : [])]);
      case "/rest/v1/memberships": return reply(200, [{ role: "owner" }]);
      case "/rest/v1/signals": {
        const destination = url.searchParams.has("recipients->1") ? "direct" :
          url.searchParams.get("channel_id") === "is.null" ? "general" : url.searchParams.get("channel_id")?.slice(3).toLowerCase();
        let rows = messages.filter(row => row.workspace === ws.workspace_id && row.fixtureDestination === destination);
        const cursor = /created_at\.eq\.([^,]+),id\.lt\.([a-f0-9-]+)/i.exec(url.searchParams.get("and") ?? "");
        if (cursor) {
          const position = rows.findIndex(row => row.id === cursor[2].toLowerCase() && row.created_at === cursor[1]);
          if (position < 0) return reply(400, {});
          if (review && rows[position].body === "History message 31" && !olderPageInterrupted) {
            olderPageInterrupted = true;
            return reply(503, {});
          }
          rows = rows.slice(position + 1);
        }
        return reply(200, rows.slice(0, 50));
      }
      default: return reply(404, {});
    }
  } catch { return reply(400, {}); }
});
server.listen(verify ? 0 : 8765, "127.0.0.1", () => {
  origin = "http://127.0.0.1:" + server.address().port;
  if (!verify) return console.log("Simulator fixture listening on loopback port 8765");
  const child = spawn(process.argv[3], [String(server.address().port), ...process.argv.slice(4)], { stdio: "inherit" });
  child.once("error", () => { process.exitCode = 1; server.close(); });
  child.once("exit", (status) => {
    if (status === 0 && process.argv[4]) {
      writeFileSync(join(dirname(process.argv[4]), "email-code.json"), JSON.stringify(emailWire, null, 2) + "\n");
      const sortedKeys = (_, value) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
      writeFileSync(join(dirname(process.argv[4]), "thread-reply.json"), JSON.stringify(threadReplyWire, sortedKeys, 2) + "\n");
      writeFileSync(join(dirname(process.argv[4]), "conversation-commands.json"),
        JSON.stringify([...conversationWire.values()], sortedKeys, 2) + "\n");
    }
    process.exitCode = status ?? 1;
    server.close();
  });
});

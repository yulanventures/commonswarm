// Simulator fixture. All state is synthetic and disappears when the process exits.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";

let origin;
const callback = "com.commonswarm.ios://auth/callback";
const me = "00000000-0000-4000-8000-000000000001";
const agent = "00000000-0000-4000-8000-000000000002";
const workspace = "00000000-0000-4000-8000-000000000003";
const channel = "00000000-0000-4000-8000-000000000004";
const codes = new Map();
const receipts = new Map();
const sessions = new Set();
let heldPost;
let notifyPost;
const postReceived = new Promise(resolve => { notifyPost = resolve; });
let authenticatedRequests = 0;
const messages = [];
const address = (command) => command.channel ? "channel" : command.to_agent_principal_id ? "direct" : "general";
const server = createServer(async (req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  };
  try {
    const url = new URL(req.url, origin);
    if (req.headers.host !== new URL(origin).host) return reply(400, {});
    if (verify && req.method === "GET" && url.pathname.startsWith("/fixture/")) {
      if (url.pathname === "/fixture/wait-for-post") {
        await postReceived;
      } else if (url.pathname === "/fixture/release") {
        heldPost?.();
      } else if (url.pathname !== "/fixture/count") return reply(404, {});
      return reply(200, authenticatedRequests);
    }
    if (req.method === "GET" && url.pathname === "/auth/v1/authorize") {
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
    if (req.headers.apikey !== "local-fixture") return reply(401, {});
    if (req.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce") {
      const pending = codes.get(body.auth_code);
      if (!pending || pending.expires <= Date.now() || typeof body.code_verifier !== "string" ||
          createHash("sha256").update(body.code_verifier).digest("base64url") !== pending.challenge) return reply(400, {});
      codes.delete(body.auth_code);
      const session = randomBytes(32).toString("hex");
      sessions.add(session);
      return reply(200, { access_token: session, user: { id: me } });
    }
    if (!sessions.has((req.headers.authorization ?? "").replace(/^Bearer /, ""))) return reply(401, {});
    authenticatedRequests++;
    if (req.method === "POST" && url.pathname === "/functions/v1/command") {
      if (body.workspace_id?.toLowerCase() !== workspace || body.command?.kind !== "post_signal") return reply(400, {});
      if (verify && body.command.body === "held during sign-out") {
        notifyPost();
        await new Promise(resolve => { heldPost = resolve; });
      }
      if (body.command.channel && body.command.expected_channel_id !== channel) return reply(404, {});
      const old = receipts.get(body.command_id);
      if (old && JSON.stringify(old.command, Object.keys(old.command).sort()) !== JSON.stringify(body.command, Object.keys(body.command).sort())) return reply(409, {});
      if (!old) {
        receipts.set(body.command_id, body);
        messages.unshift({ id: randomUUID(), from: me, from_kind: "user", body: body.command.body,
          created_at: new Date().toISOString(), fixtureDestination: address(body.command) });
      }
      return reply(200, { status: "accepted" });
    }
    if (req.method !== "GET" || req.headers["accept-profile"] !== "swarm_read") return reply(400, {});
    if (url.pathname === "/rest/v1/workspaces") return reply(200, [{ workspace_id: workspace, name: "Simulator workspace" }]);
    if (url.searchParams.get("workspace_id")?.toLowerCase() !== "eq." + workspace) return reply(403, {});
    switch (url.pathname) {
      case "/rest/v1/channels": return reply(200, [{ channel_id: channel, slug: "mobile", visibility: "open" }]);
      case "/rest/v1/member_profiles": return reply(200, [{ user_id: me, display_name: "You" }]);
      case "/rest/v1/agent_principals": return reply(200, [{ principal_id: agent, name: "Atlas" }]);
      case "/rest/v1/signals": {
        const destination = url.searchParams.has("recipients->1") ? "direct" :
          url.searchParams.get("channel_id") === "is.null" ? "general" : "channel";
        return reply(200, messages.filter(row => row.fixtureDestination === destination).slice(0, 50));
      }
      default: return reply(404, {});
    }
  } catch { return reply(400, {}); }
});
const verify = process.argv[2] === "--verify";
server.listen(verify ? 0 : 8765, "127.0.0.1", () => {
  origin = "http://127.0.0.1:" + server.address().port;
  if (!verify) return console.log("Simulator fixture listening on loopback port 8765");
  const child = spawn(process.argv[3], [String(server.address().port), ...process.argv.slice(4)], { stdio: "inherit" });
  child.once("error", () => { process.exitCode = 1; server.close(); });
  child.once("exit", (status) => { process.exitCode = status ?? 1; server.close(); });
});

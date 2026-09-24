// Production control for `cswarm mcp` (item H lane 2): one real stdio client, one seat, every tool.
// Usage: node control.mjs <cli.js> <profile.json> [host-session-id]
// Prints only tool results (allow-listed by the server) and the raw stdout-purity verdict. No secret is read here.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [cli, profile, hostSession] = process.argv.slice(2);
const args = [cli, "mcp", "--profile", profile, ...(hostSession ? ["--host-session-id", hostSession] : [])];
const transport = new StdioClientTransport({ command: process.execPath, args, stderr: "pipe" });
let stderr = "";
transport.stderr?.on("data", d => { stderr += d; });
const client = new Client({ name: "prodctl", version: "1" });
const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const rid = s => `prodctl-${stamp}-${s}`;
const log = (label, value) => console.log(`### ${label}\n${JSON.stringify(value, null, 2)}`);
const call = async (name, a = {}) => {
  const r = await client.callTool({ name, arguments: a });
  const text = r.content?.[0]?.text ?? "";
  let value; try { value = JSON.parse(text); } catch { value = { unparsed: text }; }
  return { isError: r.isError === true, value };
};
try {
  await client.connect(transport);
  log("tools", (await client.listTools()).tools.map(t => t.name));
  const who = await call("whoami"); log("whoami", who);
  const me = who.value.principal_id;
  const members = await call("members"); log("members (counts)", { isError: members.isError, members: members.value.members?.length, agents: members.value.agents?.length });
  const wo = await call("working_on", { body: "Item H lane 2: production control of cswarm mcp (one call per tool).", request_id: rid("wo") }); log("working_on", wo);
  const note = await call("note", { body: "MCP production control: note to self.", to: me, request_id: rid("note") }); log("note to self", note);
  const again = await call("note", { body: "MCP production control: note to self.", to: me, request_id: rid("note") }); log("note replay (same request_id)", again);
  log("replay kept one signal", { same_signal_id: note.value.signal_id === again.value.signal_id });
  const ask = await call("ask", { body: "MCP production control: ask to self. No action.", to: me, request_id: rid("ask") }); log("ask to self", ask);
  const reply = await call("reply", { signal_id: note.value.signal_id, body: "MCP production control: reply to own note.", request_id: rid("reply") }); log("reply to own note", reply);
  const bogus = await call("reply", { signal_id: "00000000-0000-4000-8000-000000000000", body: "x", request_id: rid("bogus") }); log("reply to unknown signal (refusal)", bogus);
  const conflict = await call("note", { body: "different body", to: me, request_id: rid("note") }); log("same request_id, new arguments (409 expected)", conflict);
  const denied = await client.callTool({ name: "note", arguments: { body: "x", request_id: rid("deny"), profile: "/x" } }).then(() => "accepted", e => ({ code: e.code }));
  log("denied key 'profile'", denied);
  const check = await call("check"); log("check (ids, kinds, from only)", { isError: check.isError, count: check.value.messages?.length, has_more: check.value.has_more,
    messages: check.value.messages?.map(m => ({ id: m.id, kind: m.kind, from: m.from, truncated: m.truncated, body: String(m.body).slice(0, 1500) })) });
  if (check.value.messages?.[0]) { const one = await call("check", { message_id: check.value.messages[0].id }); log("check {message_id} (cached)", { isError: one.isError, cached: one.value.cached, id: one.value.messages?.[0]?.id }); }
} catch (e) { log("control error", { name: e?.name, code: e?.code, message: String(e?.message).slice(0, 300) }); process.exitCode = 1; }
finally { await client.close().catch(() => {}); log("server stderr (first 600 chars)", stderr.slice(0, 600)); }

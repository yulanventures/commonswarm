/**
 * Hosted to-do/list release through the edge router. CI Docker only.
 * Input: local Supabase and the pinned edge-runtime image; switch
 * SWARM_MCP_TODOS_LISTS_ENABLED. Copied workers answer /h6-env with credential
 * names, never values. Output: catalog, seat reads, and the owner next step.
 * The storage key follows the H1 brief. Main keeps it to boot; the closed worker deletes it before the probe.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import postgres from "postgres";
import { householdRefusalNextStep } from "../../src/protocol/household-next-steps.js";
import { HOSTED_TODO_LIST_TOOLS } from "../../src/protocol/household-tool-registry.js";
import { MCP_ISSUER, MCP_JWKS_URL, MCP_RESOURCE } from "../../supabase/functions/mcp/auth.js";
import { DOCKER_UNAVAILABLE, awaitHealth, dockerAvailable, functionsRoot, startComposeEdgeRuntime, type EdgeRuntimeHandle } from "../support/edge-runtime-function-boot.js";

const KEY = "SUPABASE_SERVICE_ROLE_KEY", OAUTH = "MCP_OAUTH_SIGNING_KEYS_FILE", MARKER = "H6ListItemMarker"; let omitStorage = false;
const coreNames = ["claim_seat", "whoami", "check", "ask", "note", "reply", "working_on", "members"];
const hostedNames = [...coreNames, ...HOSTED_TODO_LIST_TOOLS.map((tool) => tool.name)];
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const guardedRemove = (directory: string) => {
  const cleanup = spawnSync("rm", ["-rf", "--", directory], { encoding: "utf8" });
  assert.equal(cleanup.status, 0, `guarded cleanup refused ${directory}: ${cleanup.stderr}`);
};

interface Local { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string }
function localEnvironment(): Local {
  const result = spawnSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0, "supabase status failed");
  const parsed = JSON.parse(result.stdout) as Partial<Local>;
  assert.ok(parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  return parsed as Local;
}

async function signer(): Promise<{ jwks: string; issue: (sub: string, grantId: string) => Promise<string> }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "server-suite", alg: "ES256", use: "sig" };
  const issue = async (sub: string, grantId: string) => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64(Buffer.from(JSON.stringify({ alg: "ES256", kid: "server-suite", typ: "at+jwt" })));
    const payload = b64(Buffer.from(JSON.stringify({ iss: MCP_ISSUER, aud: MCP_RESOURCE, sub, grant_id: grantId, client_id: "synthetic-client", scope: "mcp", iat: now, exp: now + 300 })));
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.from(`${header}.${payload}`));
    return `${header}.${payload}.${b64(new Uint8Array(signature))}`;
  };
  return { jwks: JSON.stringify({ keys: [publicJwk] }), issue };
}

/** Credential-name probe on copied workers. JWKS fetch is injected into the MCP verifier constructor. */
function instrument(root: string, jwks: string): void {
  const shim = `const __h6=(handler:(request:Request)=>Response|Promise<Response>)=>(request:Request)=>{if(request.headers.get("x-h6-omit-storage")==="1")Deno.env.delete(${JSON.stringify(KEY)});if(new URL(request.url).pathname.endsWith("/h6-env")){const names=[${JSON.stringify(KEY)},"SWARM_DATABASE_URL",${JSON.stringify(OAUTH)}] as const;return new Response(JSON.stringify({present:names.filter((name)=>Deno.env.get(name)!==undefined),flag:Deno.env.get("SWARM_MCP_TODOS_LISTS_ENABLED")??null}),{headers:{"content-type":"application/json"}});}return handler(request);};\n`;
  const verifierNeedle = "clockSkewSeconds: boundedInteger(\"SWARM_MCP_CLOCK_SKEW_SECONDS\", 30, 0, 60),\n});";
  const verifierLive = `clockSkewSeconds: boundedInteger("SWARM_MCP_CLOCK_SKEW_SECONDS", 30, 0, 60),\n  fetch: async () => new Response(${JSON.stringify(jwks)}, { status: 200 }),\n});`;
  for (const name of ["mcp", "read", "command"]) {
    const path = join(root, name, "index.ts"), needle = "if (import.meta.main) Deno.serve(handleRequest);";
    const source = readFileSync(path, "utf8");
    assert.equal(source.includes(needle), true, `${name} serve`);
    let next = source.replace(needle, `${shim}if (import.meta.main) Deno.serve(__h6(handleRequest));`);
    if (name === "mcp") {
      assert.equal(next.includes(verifierNeedle), true, "mcp verifier");
      next = next.replace(verifierNeedle, verifierLive);
    }
    writeFileSync(path, next);
  }
  const h0Path = join(root, "h0", "index.ts");
  const closed = readFileSync(h0Path, "utf8").replace("Deno.serve((request) => {", `${shim}Deno.serve(__h6((request) => {`).replace(/\}\);\n$/, "}));\n");
  assert.equal(closed.includes("Deno.serve(__h6((request)"), true, "h0 serve");
  writeFileSync(h0Path, closed);
}

function edgeEnv(local: Local, flag: boolean): string {
  const lines = [`SUPABASE_URL=${local.API_URL}`, `SUPABASE_ANON_KEY=${local.ANON_KEY}`, `SUPABASE_SERVICE_ROLE_KEY=${local.SERVICE_ROLE_KEY}`, "SWARM_SELF_SERVE=1", `SWARM_DATABASE_URL=${local.DB_URL}`, "SWARM_MCP_PUBLIC_ENABLED=1", `SWARM_MCP_ISSUER=${MCP_ISSUER}`, `SWARM_MCP_RESOURCE=${MCP_RESOURCE}`, `SWARM_MCP_JWKS_URL=${MCP_JWKS_URL}`, `${OAUTH}=decoy-oauth-material`];
  if (flag) lines.push("SWARM_MCP_TODOS_LISTS_ENABLED=1");
  return `${lines.join("\n")}\n`;
}

function seed(owner: string, workspace: string, principal: string, other: string, grant: string, seat: string, otherSeat: string, approved: string, unapproved: string): string {
  const stream = randomUUID(), consent = randomUUID(), receipt = randomUUID(), link = randomUUID();
  return [`INSERT INTO auth.users(id,aud,role,email) VALUES ('${owner}','authenticated','authenticated','${owner}@example.test'); INSERT INTO swarm.users(user_id,display_name) VALUES ('${owner}','Synthetic owner')`,
    `INSERT INTO swarm.config(key,value) VALUES ('min_client_version','"0.1.0"') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value; INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES ('${workspace}','Synthetic household','${owner}')`,
    `INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES ('${workspace}','${owner}','owner'); INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES ('${stream}','${workspace}','workspace')`,
    `INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES ('${workspace}','shared'); INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at) VALUES ('${workspace}','${owner}','editor','${consent}',clock_timestamp())`,
    `INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only) VALUES ('${principal}','${workspace}','${owner}','Synthetic hosted seat','hosted_mcp',true),('${other}','${workspace}','${owner}','Synthetic unapproved seat','hosted_mcp',true); INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at) VALUES ('${grant}','synthetic-${grant}','${owner}','${workspace}','synthetic-client','${MCP_RESOURCE}',ARRAY['${workspace}']::uuid[],decode(repeat('a',64),'hex'),'synthetic-consent','active',clock_timestamp(),clock_timestamp())`,
    `INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at) VALUES ('${grant}','${workspace}','${owner}',decode(repeat('a',64),'hex'),'${receipt}',clock_timestamp())`,
    `INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at) VALUES ('${seat}','${grant}','${workspace}','${owner}','${principal}','Synthetic hosted seat',clock_timestamp()),('${otherSeat}','${grant}','${workspace}','${owner}','${other}','Synthetic unapproved seat',clock_timestamp()); INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at) VALUES ('${approved}','${seat}','${grant}','${workspace}','${principal}',clock_timestamp()),('${unapproved}','${otherSeat}','${grant}','${workspace}','${other}',clock_timestamp())`,
    `INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id) VALUES ('${seat}','${grant}','${workspace}','${principal}','${owner}','shared',ARRAY['read','create','update'],'${link}',NULL,'${grant}')`,
  ].join(";\n");
}

async function probe(base: string, name: string, secret: string, storage: boolean, flag?: string | null): Promise<void> {
  const response = await fetch(`${base}/functions/v1/${name}/h6-env`, { method: "POST", body: "{}", signal: AbortSignal.timeout(180_000), headers: omitStorage ? { "x-h6-omit-storage": "1" } : {} });
  const text = await response.text();
  assert.equal(text.indexOf(secret), -1); assert.equal(response.status, 200, `${name} probe status ${response.status}`);
  const body = JSON.parse(text) as { present: string[]; flag: string | null };
  assert.equal(body.present.includes("SWARM_DATABASE_URL") && body.present.includes(KEY) === storage && !body.present.includes(OAUTH), true);
  if (flag !== undefined) assert.equal(body.flag, flag);
}

type Rpc = { result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] }; error?: { code: number } };
async function rpc(base: string, token: string, secret: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${base}/functions/v1/mcp`, { method: "POST", signal: AbortSignal.timeout(180_000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "mcp-protocol-version": "2025-06-18", ...(omitStorage ? { "x-h6-omit-storage": "1" } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: "h6", method, params }) });
  const text = await response.text();
  assert.equal(text.indexOf(secret), -1);
  return { status: response.status, json: JSON.parse(text) as Rpc };
}
function output(json: Rpc, secret: string): Record<string, unknown> {
  const text = json.result?.content?.[0]?.text ?? "";
  assert.equal(text.indexOf(secret), -1); assert.notEqual(json.result?.isError, true);
  return JSON.parse(text) as Record<string, unknown>;
}

test("edge router admits hosted to-do and list tools only with the storage brief", { timeout: 900_000 }, async (t) => {
  if (!dockerAvailable()) { t.skip(DOCKER_UNAVAILABLE); return; }
  const local = localEnvironment(), secret = local.SERVICE_ROLE_KEY, { jwks, issue } = await signer();
  const owner = randomUUID(), workspace = randomUUID(), principal = randomUUID(), other = randomUUID();
  const grant = randomUUID(), seat = randomUUID(), otherSeat = randomUUID();
  const approved = `seat_${randomUUID().replaceAll("-", "").slice(0, 22)}`, unapproved = `seat_${randomUUID().replaceAll("-", "").slice(0, 22)}`, grantId = `synthetic-${grant}`;
  const sql = postgres(local.DB_URL, { max: 1, prepare: false });
  const workDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "h6-edge.")));
  const copy = join(workDir, "functions");
  let runtime: EdgeRuntimeHandle | undefined;
  const stopRuntime = () => { const current = runtime; let failure: unknown = undefined; try { if (current) assert.equal(current.logs().indexOf(secret), -1); } catch (error) { failure = error; } finally { try { current?.close(); runtime = undefined; } catch (error) { failure ??= error; } } if (failure) throw failure; };
  t.after(async () => { let failure: unknown = undefined; try { stopRuntime(); } catch (error) { failure = error; } finally { try { await sql.end({ timeout: 5 }); } catch (error) { failure ??= error; } try { guardedRemove(workDir); } catch (error) { failure ??= error; } } if (failure) throw failure; });
  await sql.unsafe(seed(owner, workspace, principal, other, grant, seat, otherSeat, approved, unapproved));
  mkdirSync(copy, { recursive: true }); cpSync(functionsRoot, copy, { recursive: true }); instrument(copy, jwks);
  const boot = async (flag: boolean) => {
    stopRuntime();
    runtime = await startComposeEdgeRuntime({ workDir, functionsRoot: copy, envText: edgeEnv(local, flag), composeEnv: { COMMONSWARM_EDGE_NETWORK_MODE: "host" } });
    await awaitHealth(runtime.baseUrl, 60_000);
    return runtime.baseUrl;
  };
  const call = async (base: string, token: string, name: string, args: Record<string, unknown>) => {
    const response = await rpc(base, token, secret, "tools/call", { name, arguments: args });
    assert.equal(response.status, 200, name); return output(response.json, secret);
  };
  const off = await boot(false), token = await issue(owner, grantId);
  await probe(off, "mcp", secret, false, null); await probe(off, "read", secret, true);
  await probe(off, "h0", secret, false); await probe(off, "command", secret, true);
  assert.equal((await rpc(off, token, secret, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "h6", version: "0" } })).status, 200);
  const listed = await rpc(off, token, secret, "tools/list", {}); assert.deepEqual([listed.status, listed.json.result?.tools?.length, listed.json.result?.tools?.map((tool) => tool.name)], [200, 8, coreNames]);
  assert.equal((await call(off, token, "whoami", { seat: approved })).handle, approved);
  const unknown = await rpc(off, token, secret, "tools/call", { name: "todo_read", arguments: { seat: approved, todo_id: randomUUID() } }); assert.equal(unknown.status, 400); assert.equal(unknown.json.error?.code, -32602);
  const on = await boot(true), live = await issue(owner, grantId);
  await probe(on, "mcp", secret, true, "1"); await probe(on, "h0", secret, false); await probe(on, "read", secret, true);
  const enabled = await rpc(on, live, secret, "tools/list", {}); assert.equal(enabled.status, 200); assert.deepEqual(enabled.json.result?.tools?.map((tool) => tool.name), hostedNames);
  assert.equal((await call(on, live, "list_create", { seat: approved, request_id: "h6list01", object_id: "h6list", title: "H6 shared list", content: { kind: "list", items: [{ item_id: "milk", text: MARKER, order: 0, checked: false }] } })).status, "committed");
  const page = await call(on, live, "list_list", { seat: approved, offset: 0, limit: 10 });
  assert.deepEqual([page.status, page.kind, (page.objects as { object_id: string }[]).some((row) => row.object_id === "h6list")], ["ok", "object_list", true]);
  const todo = await call(on, live, "todo_create", { seat: approved, request_id: "h6todo01", title: "H6 shared todo" }); const todoId = (todo.value as { todo_id: string }).todo_id; assert.equal(todo.status, "committed");
  const title = async (handle: string) => ((await call(on, live, "todo_read", { seat: handle, todo_id: todoId })).todo as { title?: string }).title;
  assert.equal(await title(approved), "H6 shared todo");
  assert.equal((await call(on, live, "whoami", { seat: unapproved })).handle, unapproved);
  const refusal = await call(on, live, "todo_read", { seat: unapproved, todo_id: todoId });
  assert.deepEqual([refusal.status, refusal.reason, refusal.next_action], ["refused", "workspace_access_refused", householdRefusalNextStep("workspace_access_refused")]);
  assert.equal(await title(approved), "H6 shared todo");
  assert.equal(((await call(on, live, "list_read", { seat: approved, object_id: "h6list" })).content as { items: { text: string }[] }).items[0]?.text, MARKER);
  omitStorage = true; const closed = await boot(true), bare = await issue(owner, grantId);
  await probe(closed, "mcp", secret, false, "1");
  assert.equal(((await call(closed, bare, "todo_read", { seat: approved, todo_id: todoId })).todo as { title?: string }).title, "H6 shared todo");
  const meta = await call(closed, bare, "list_list", { seat: approved, offset: 0, limit: 10 }); assert.deepEqual([meta.status, meta.kind, (meta.objects as { object_id: string }[]).some((row) => row.object_id === "h6list")], ["ok", "object_list", true]);
  const denied = await rpc(closed, bare, secret, "tools/call", { name: "list_read", arguments: { seat: approved, object_id: "h6list" } }); assert.deepEqual([denied.status, denied.json.result?.isError, denied.json.result?.content?.[0]?.text], [200, true, JSON.stringify({ error: "tool_failed", message: "Something failed on our side; retry with the same request_id; if it repeats, contact support@commonswarm.com" })]);
});

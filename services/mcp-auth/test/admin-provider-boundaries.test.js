import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { errors } from "oidc-provider";
import { createMcpProvider, ISSUER, RESOURCE } from "../src/provider.js";
import { ADMIN_RESOURCE } from "../src/admin-policy.generated.js";
import { createAdminHttpHandler } from "../src/admin-http.js";
import { createPostgresAdapter } from "../src/postgres-adapter.js";

async function fixture(t, { issuerPool = null } = {}) {
  const clientId = "https://client.example/metadata", redirect = "https://client.example/callback";
  const provider = await createMcpProvider({ fetch: async () => new Response(JSON.stringify({ client_id: clientId,
    redirect_uris: [redirect], grant_types: ["authorization_code","refresh_token"], response_types:["code"],
    token_endpoint_auth_method:"none", application_type:"web" }),{ headers:{"content-type":"application/json"} }) });
  const handler=async (request,response)=>{
    if (request.url.startsWith("/interaction/")) {
      const details=await provider.interactionDetails(request,response);
      if (details.prompt.name === "login") await provider.interactionFinished(request,response,{login:{accountId:"test-owner"}});
      else {
        const grant=details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({accountId:"test-owner",clientId});
        grant.addOIDCScope((details.prompt.details.missingOIDCScope ?? []).join(" ")); grant.addResourceScope(RESOURCE,"mcp");
        if (details.prompt.details.missingOIDCClaims) grant.addOIDCClaims(details.prompt.details.missingOIDCClaims);
        await provider.interactionFinished(request,response,{consent:{grantId:await grant.save()}});
      }
    } else await provider.callback()(request,response);
  };
  let lookups = 0;
  const server=createServer(createAdminHttpHandler({ handler,runtimePool:{query:async()=>{ ++lookups; return {rows:[]}; }},issuerPool }));
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`,cookies=new Map();
  async function request(path,body) {
    const headers={host:new URL(ISSUER).host,"x-forwarded-host":new URL(ISSUER).host,"x-forwarded-proto":"https"};
    if (body) headers["content-type"]="application/x-www-form-urlencoded";
    headers.cookie=[...cookies].map(([key,value])=>`${key}=${value}`).join("; ");
    const response=await fetch(new URL(path,origin),{method:body ? "POST":"GET",headers,
      body:body ? new URLSearchParams(body):undefined,redirect:"manual"});
    for(const item of response.headers.getSetCookie()) { const pair=item.split(";",1)[0],at=pair.indexOf("=");cookies.set(pair.slice(0,at),pair.slice(at+1)); }
    return response;
  }
  async function tokens() {
    const verifier="boundary-verifier-0123456789abcdefghijklmnopqrstuvwxyz";
    const query=new URLSearchParams({client_id:clientId,redirect_uri:redirect,response_type:"code",
      scope:"openid offline_access mcp",prompt:"consent",resource:RESOURCE,code_challenge_method:"S256",
      code_challenge:createHash("sha256").update(verifier).digest("base64url"),state:randomUUID()});
    let response=await request(`/authorize?${query}`);
    for(let i=0;i<8 && [302,303].includes(response.status);i++) {
      const location=new URL(response.headers.get("location"),ISSUER);
      if(location.origin === new URL(redirect).origin) {
        response=await request("/token",{client_id:clientId,grant_type:"authorization_code",code:location.searchParams.get("code"),
          code_verifier:verifier,redirect_uri:redirect,resource:RESOURCE});
        assert.equal(response.status,200);return response.json();
      }
      response=await request(location.pathname+location.search);
    }
    throw new Error("ordinary MCP positive did not reach code exchange");
  }
  return { provider,request,tokens,clientId, get lookups() { return lookups; } };
}

for (const { name, grantType, detail, replay } of [
  { name: "invalid authorization code", grantType: "authorization_code", detail: "authorization code not found" },
  { name: "invalid refresh token", grantType: "refresh_token", detail: "refresh token not found" },
  { name: "replayed refresh token", grantType: "refresh_token", detail: "refresh token already used", replay: true },
]) {
  test(`ordinary admin-http composition preserves invalid_grant and grant.error for ${name}`, async t => {
    const f = await fixture(t), failures = [];
    let successes = 0;
    f.provider.on("grant.error", (_ctx, error) => failures.push(error));
    f.provider.on("grant.success", () => ++successes);

    // Issue through the same wrapped HTTP server, not directly through models.
    const issued = await f.tokens();
    assert.equal(typeof issued.access_token, "string");
    assert.equal(typeof issued.refresh_token, "string");
    assert.equal(successes, 1);
    if (replay) {
      const refreshed = await f.request("/token", { client_id: f.clientId, grant_type: "refresh_token",
        refresh_token: issued.refresh_token, resource: RESOURCE });
      assert.equal(refreshed.status, 200);
      const rotated = await refreshed.json();
      assert.equal(typeof rotated.access_token, "string");
      assert.equal(typeof rotated.refresh_token, "string");
      assert.notEqual(rotated.refresh_token, issued.refresh_token);
      assert.equal(successes, 2);
    }

    const lookupsBefore = f.lookups, successesBefore = successes;
    const response = await f.request("/token", { client_id: f.clientId, grant_type: grantType,
      resource: RESOURCE, ...(grantType === "authorization_code"
        ? { code: "not-an-issued-code", code_verifier: "boundary-verifier-0123456789abcdefghijklmnopqrstuvwxyz",
          redirect_uri: "https://client.example/callback" }
        : { refresh_token: replay ? issued.refresh_token : "not-an-issued-refresh" }) });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error, "invalid_grant");
    assert.equal(body.error_description, "grant request is invalid");
    assert.equal(failures.length, 1, "the provider must emit grant.error for the failed exchange");
    assert.ok(failures[0] instanceof errors.InvalidGrant);
    assert.equal(failures[0].statusCode, 400);
    assert.equal(failures[0].error_description, "grant request is invalid");
    assert.equal(failures[0].error_detail, detail);
    assert.equal(successes, successesBefore, "a failed exchange must not emit grant.success");
    assert.equal(f.lookups, lookupsBefore, "ordinary token failures must not query admin state");
  });
}

test("mcp-refresh-never-admin: real MCP refresh cannot change resource; the same predecessor still refreshes MCP",async t=>{
  const f=await fixture(t),tokens=await f.tokens();
  const escalated=await f.request("/token",{client_id:f.clientId,grant_type:"refresh_token",refresh_token:tokens.refresh_token,resource:ADMIN_RESOURCE});
  assert.equal(escalated.status,503);
  assert.equal((await escalated.json()).error,"admin_issuance_disabled");
  const good=await f.request("/token",{client_id:f.clientId,grant_type:"refresh_token",refresh_token:tokens.refresh_token,resource:RESOURCE});
  assert.equal(good.status,200); assert.equal(typeof (await good.json()).access_token,"string");
});

test("admin-scopes-resource-only: provider resource scopes are separate from OIDC; MCP and multiresource upserts refuse admin",async t=>{
  const f=await fixture(t),grant=new f.provider.Grant({accountId:"owner",clientId:f.clientId});
  grant.addOIDCScope("openid offline_access"); grant.addResourceScope(ADMIN_RESOURCE,"admin:read");
  assert.equal(grant.getOIDCScope(),"openid offline_access");
  assert.equal(grant.getResourceScope(ADMIN_RESOURCE),"admin:read");
  const denied=await f.request(`/authorize?${new URLSearchParams({client_id:f.clientId,resource:RESOURCE,
    scope:"admin:read",response_type:"code",redirect_uri:"https://client.example/callback"})}`);
  assert.equal(denied.status,400); assert.equal((await denied.json()).error,"invalid_scope");
  const adapter=createPostgresAdapter({query:async()=>({rows:[]}),connect:async()=>({query:async sql=>({rows:[],command:sql}),release(){}})})("Grant");
  await assert.rejects(adapter.upsert("bad",{resources:{[RESOURCE]:"mcp",[ADMIN_RESOURCE]:"admin:read"}},60),{error:"invalid_target"});
  await assert.rejects(adapter.upsert("admin",{resources:{[ADMIN_RESOURCE]:"admin:read"}},60),{code:"admin_transaction_required"});
  await adapter.upsert("mcp",{resources:{[RESOURCE]:"mcp"}},60);
  await adapter.upsert("native-mcp",{resource:[RESOURCE]},60);
  await assert.rejects(adapter.upsert("multi-resource",{resource:[RESOURCE,ADMIN_RESOURCE]},60),{error:"invalid_target"});
  let mutations=0;
  const boundAdapter=createPostgresAdapter({query:async()=>({rows:[{payload:{resource:ADMIN_RESOURCE,grantId:"bound-admin-family"}}]}),
    connect:async()=>{++mutations;throw new Error("unexpected mutation connection");}})("RefreshToken");
  await assert.rejects(boundAdapter.upsert("new-unlabelled-admin-refresh",{grantId:"bound-admin-family"},60),
    {code:"admin_transaction_required"});
  assert.equal(mutations,0,"a new artifact cannot bypass ALS by omitting its resource field");

});

test("admin-issuance-closed-before-cutover: admin authorization/code/refresh refuse and ordinary OAuth still succeeds",async t=>{
  let connections = 0;
  const f=await fixture(t, { issuerPool: { connect: async () => { ++connections; throw new Error("unexpected issuer SQL"); } } });
  const auth=await f.request(`/authorize?${new URLSearchParams({client_id:f.clientId,resource:ADMIN_RESOURCE,
    scope:"openid offline_access admin:read",response_type:"code",redirect_uri:"https://client.example/callback"})}`);
  assert.equal(auth.status,503);
  assert.equal((await auth.json()).error,"admin_issuance_disabled");
  const lookupsBefore = f.lookups;
  for(const grant_type of ["authorization_code","refresh_token"]) {
    const response=await f.request("/token",{client_id:f.clientId,resource:ADMIN_RESOURCE,grant_type,
      code:"not-an-issued-admin-code",refresh_token:"not-an-issued-admin-refresh"});
    assert.equal(response.status,503);
    assert.equal((await response.json()).error,"admin_issuance_disabled");
  }
  assert.equal(f.lookups,lookupsBefore,"closed admin token ingress must refuse before any SQL");
  assert.equal(connections,0,"a configured issuer pool must not bypass the literal closure");
  assert.equal(typeof (await f.tokens()).refresh_token,"string");
});

test("ordinary /token delegates the original unread HTTP stream without an admin lookup", async t => {
  const body = "grant_type=refresh_token&resource=https%3A%2F%2Fmcp.commonswarm.com%2Fmcp&refresh_token=transport-control";
  let delegated = false, lookups = 0, originalStream, unread, received = "";
  const server = createServer((original, response) => createAdminHttpHandler({
    runtimePool: { query: async () => { ++lookups; return { rows: [] }; } }, issuerPool: null,
    handler: async request => {
      originalStream = request === original;
      unread = request.readable;
      for await (const chunk of request) received += chunk.toString();
      delegated = true;
      response.writeHead(200);
      response.end("delegated");
    },
  })(original, response));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await fetch(`http://127.0.0.1:${server.address().port}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), "delegated");
  assert.equal(originalStream, true, "the provider must receive the IncomingMessage, not a replay stream");
  assert.equal(unread, true, "ingress must leave body parsing to the provider");
  assert.equal(received, body);
  assert.equal(delegated, true);
  assert.equal(lookups, 0, "ordinary token ingress must not query admin state");
});

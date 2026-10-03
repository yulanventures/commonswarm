import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { createMcpProvider, ISSUER, RESOURCE } from "../src/provider.js";
import { ADMIN_RESOURCE } from "../src/admin-policy.generated.js";
import { createAdminHttpHandler } from "../src/admin-http.js";
import { createPostgresAdapter } from "../src/postgres-adapter.js";

async function fixture(t) {
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
  const server=createServer(createAdminHttpHandler({ handler,runtimePool:{query:async()=>({rows:[]})},issuerPool:null }));
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
  return { provider,request,tokens,clientId };
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
  let mutations=0;
  const boundAdapter=createPostgresAdapter({query:async()=>({rows:[{grant_class:"delegated_admin"}]}),
    connect:async()=>{++mutations;throw new Error("unexpected mutation connection");}})("RefreshToken");
  await assert.rejects(boundAdapter.upsert("new-unlabelled-admin-refresh",{grantId:"bound-admin-family"},60),
    {code:"admin_transaction_required"});
  assert.equal(mutations,0,"a new artifact cannot bypass ALS by omitting its resource field");

});

test("admin-issuance-closed-before-cutover: admin authorization/code/refresh refuse and ordinary OAuth still succeeds",async t=>{
  const f=await fixture(t);
  const auth=await f.request(`/authorize?${new URLSearchParams({client_id:f.clientId,resource:ADMIN_RESOURCE,
    scope:"openid offline_access admin:read",response_type:"code",redirect_uri:"https://client.example/callback"})}`);
  assert.equal(auth.status,503);
  for(const grant_type of ["authorization_code","refresh_token"]) {
    const response=await f.request("/token",{client_id:f.clientId,resource:ADMIN_RESOURCE,grant_type,
      code:"not-an-issued-admin-code",refresh_token:"not-an-issued-admin-refresh"});
    assert.equal(response.status,503);
  }
  assert.equal(typeof (await f.tokens()).refresh_token,"string");
});

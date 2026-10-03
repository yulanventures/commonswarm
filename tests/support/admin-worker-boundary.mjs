// No stack or runtime network permission. Exercise the production HTTP handlers;
// Deno.serve is captured only to avoid opening a listener during imports.
import assert from 'node:assert/strict';
import { securityReasons } from './admin-boundary-db.mjs';
Deno.env.set('SWARM_ENV', 'test');
Deno.env.set('SWARM_DATABASE_URL', 'postgres://fixture:fixture@127.0.0.1:1/fixture');
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:1');
Deno.env.set('SUPABASE_ANON_KEY', 'fixture');
Deno.env.set('SWARM_MCP_PUBLIC_ENABLED', '1');
Deno.env.set('SWARM_CAPABILITY_URLS', '1');
let authCalls = 0;
globalThis.fetch = () => { authCalls++; throw new Error('unexpected_authentication'); };
let served;
Deno.serve = handler => { served = handler; };
const { handleRequest: read, handleHostedRead } = await import('../../supabase/functions/read/index.ts');
const { handleGatewayRequest, rewriteFunctionRequest } = await import('../../deploy/edge-runtime/main/router.ts');
const { handleRequest: command, handleHostedCommand } = await import('../../supabase/functions/command/index.ts');
const { handleRequest: mcp } = await import('../../supabase/functions/mcp/index.ts');
await import('../../supabase/functions/activity/index.ts');
const activity = served;
await import('../../supabase/functions/capability/index.ts');
const capability = served;
await import('../../supabase/functions/h0/index.ts');
const h0 = served;
const workspace = '11111111-1111-4111-8111-111111111111';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const audience = 'https://api.commonswarm.com/admin';
const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
async function jwt(aud) {
  const now = Math.floor(Date.now() / 1000);
  const message = `${encode({ alg: 'ES256', typ: 'at+jwt', kid: 'fixture' })}.${encode({ iss: 'https://mcp.commonswarm.com',
    aud, sub: workspace, grant_id: workspace, connection_id: workspace, client_id: 'fixture', iat: now, exp: now + 300 })}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signing.privateKey, Buffer.from(message));
  return `${message}.${Buffer.from(signature).toString('base64url')}`;
}
const tokens = ['swm_adm_' + 'a'.repeat(43), 'swm_adr_' + 'b'.repeat(43),
  await jwt(audience), await jwt([audience]), await jwt(['https://mcp.commonswarm.com/mcp', audience])];
function request(path, token, method = 'POST', body = '{') {
  return new Request(`http://127.0.0.1${path}`, { method,
    headers: { authorization: `bEaReR  ${token}`, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body } : {}) });
}
// Positive controls reach ordinary method/body handling in the same invocation.
const worker = 'swm_agt_' + 'c'.repeat(43);
assert.equal((await read(request('/read', worker, 'GET'))).status, 405);
assert.equal((await read(request('/read', worker))).status, 400);
assert.equal((await command(request('/command', worker, 'GET'))).status, 405);
assert.equal((await activity(request('/activity', worker, 'GET'))).status, 405);
assert.equal((await h0(new Request('http://127.0.0.1/h0/agent-doc/fixture'))).status, 200);
assert.equal((await mcp(new Request('http://127.0.0.1/.well-known/oauth-protected-resource/mcp'))).status, 200);
// The release smoke enters the production gateway without an apikey. Exercise
// its dispatch and path rewrite with the real read handler, without a listener.
let readDispatches = 0;
async function gatewayRead(input) {
  return await handleGatewayRequest(input, true, async (route, original) => {
    assert.equal(route.functionName, 'read');
    assert.equal(route.pathname, '/read');
    readDispatches++;
    return await read(rewriteFunctionRequest(original, route.pathname));
  });
}
assert.equal((await gatewayRead(new Request('https://api.commonswarm.com/functions/v1/read', {
  method: 'GET',
}))).status, 405, 'positive control reaches the read worker through dispatch');
const smoke = await gatewayRead(new Request('https://api.commonswarm.com/functions/v1/read', {
  method: 'POST',
  headers: { authorization: 'Bearer swm_adm_release_probe_not_a_credential',
    'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ resource: 'admin_grants', workspace_id: null, limit: 1, before: null }),
}));
assert.equal(readDispatches, 2, 'a gateway denial cannot masquerade as a read refusal');
assert.equal(smoke.status, 403);
assert.match(smoke.headers.get('content-type'), /^application\/json\b/u);
assert.deepEqual(await smoke.json(), { error: 'credential_kind_forbidden' });
for (const token of tokens) {
  assert.equal((await command(request('/command', token))).status, 401, 'retired or Bearer admin cannot select account authority');
  assert.equal((await h0(request('/h0/register', worker, 'POST', JSON.stringify({
    joinCredential: token, attemptId: workspace, name: 'fixture',
  })))).status, 401, 'H0 refuses an admin credential in the registration body before forwarding');
  for (const resource of ['whoami', 'members', 'signals']) {
    assert.equal((await handleHostedRead({ resource, workspace_id: workspace }, token)).status, 403, 'hosted read accepts only an opaque capability');
  }
  assert.equal((await handleHostedCommand({ command_id: crypto.randomUUID(), workspace_id: workspace,
    stream: { kind: 'workspace' }, command: { kind: 'post_signal', body: 'fixture' } }, token)).status, 403,
    'hosted command accepts only an opaque capability');
  for (const method of ['GET', 'POST']) {
    const response = await read(request('/read?view=members&workspace_id=' + workspace, token, method));
    assert.equal(response.status, 403, 'worker read rejects admin before method/body handling');
    assert.deepEqual(await response.json(), { error: 'credential_kind_forbidden' });
  }
  // All read projections, including the two human fallback branches.
  for (const resource of ['members', 'signals', 'channels', 'files', 'delivery_receipts', 'renewal_grants', 'pending_access', 'agent_wake_lease']) {
    assert.equal((await read(request('/read', token, 'POST', JSON.stringify({ resource, workspace_id: workspace })))).status, 403, resource);
  }
  for (const method of ['GET', 'POST']) {
    const response = await command(request('/command', token, method,
      JSON.stringify({ command_id: crypto.randomUUID(), workspace_id: workspace, stream: { kind: 'workspace' },
        command: { kind: 'post_signal', body: 'fixture' } })));
    assert.equal(response.status, 401, 'worker command rejects Bearer admin');
    assert.deepEqual(await response.json(), { error: 'unauthenticated' });
    assert.equal((await activity(request('/activity', token, method))).status, 401, 'activity foreign credential');
    assert.equal((await capability(request('/capability', token, method))).status, 404, 'capability uniform refusal');
    const hosted = await mcp(request('/mcp', token, method));
    assert.equal(hosted.status, 401, 'MCP foreign credential');
    assert.deepEqual(await hosted.json(), { error: 'unauthorized' });
    assert.match(hosted.headers.get('www-authenticate'), /resource_metadata=/u);
    for (const verb of ['poll', 'ack', 'register', 'ask', 'note', 'reply', 'working-on']) {
      assert.equal((await h0(request('/h0/' + verb, token, method))).status, 401, 'H0 ' + verb);
    }
  }
}
assert.equal(securityReasons.length, tokens.length * 3, 'every anonymous command refusal charges only the bounded security helper');
assert.equal(authCalls, 0, 'admin never reaches GoTrue, JWKS, or a forwarded request');
for (const token of tokens) {
  for (const handler of [read, activity, capability, mcp, h0]) {
    const req = request('/read',token);req.headers.set('authorization',`DPoP ${token}`);
    const response = await handler(req);
    if (handler === read) {
      assert.equal(response.status,403,'DPoP admin is classified before method/body handling');
      assert.deepEqual(await response.json(),{error:'credential_kind_forbidden'});
    } else assert.ok(response.status>=400,'DPoP admin stays outside ordinary authority');
  }
}
assert.equal(authCalls,0,'both admin schemes refused without GoTrue at ordinary surfaces');
console.log('ADMIN_WORKER_BOUNDARY_OK');

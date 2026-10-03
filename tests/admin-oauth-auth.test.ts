import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { cryptoFixture } from './support/admin-oauth-crypto.js';
// @ts-expect-error TS5097 real edge cryptographic boundary
import { AdminProofError, AdminTokenError, AdminJwtVerifier, AdminRequestVerifier, adminTokenDigest, base64url, isAdminAdmission, ADMIN_COMMAND_URI, ADMIN_MCP_URI } from '../supabase/functions/_shared/admin-oauth-auth.ts';
// @ts-expect-error TS5097 denial boundary
import { presentsAdminCredential } from '../supabase/functions/_shared/admin-credential-boundary.ts';

function store() {
  const nonces = new Map<string, string>(), proofs = new Set<string>();
  let calls = 0;
  return {
    get calls() { return calls; },
    async registerNonce(digest: Uint8Array, jkt: string) { nonces.set(Buffer.from(digest).toString('hex'), jkt); return true; },
    async admit(jti: string, jkt: string, _domain: string, iat: number, nonce: Uint8Array | null) {
      calls++;
      if (iat < Math.floor(Date.now()/1000) - 60 || iat > Math.floor(Date.now()/1000) + 5) return 'stale_proof' as const;
      if (!nonce || nonces.get(Buffer.from(nonce).toString('hex')) !== jkt) return 'nonce_required' as const;
      const key = `${jti}:${jkt}`;
      if (proofs.has(key)) return 'replay' as const;
      proofs.add(key); return 'accepted' as const;
    },
  };
}
async function nonce(f: Awaited<ReturnType<typeof cryptoFixture>>, access: string) {
  let challenge: string | undefined;
  await assert.rejects(f.verifier.verify(await f.request(access), 'admin_command'), (e: unknown) => {
    assert.ok(e instanceof AdminProofError); assert.equal(e.code, 'nonce_required'); challenge = e.nonce; return true;
  });
  assert.match(challenge!, /^[A-Za-z0-9_-]{43}$/);
  return challenge!;
}

test('admin-dpop-verifier-unit: real signatures, nonce challenges, cross-entry proofs, separate verifiers and restart with fresh-proof controls', async () => {
  const shared = store(), f = await cryptoFixture(shared), access = await f.token(), n = await nonce(f, access), jti = randomUUID();
  const first = await f.request(access, 'admin_command', {}, { nonce: n, jti });
  const secondVerifier = new AdminRequestVerifier(f.jwt, shared);
  const outcomes = await Promise.allSettled([f.verifier.verify(first, 'admin_command'), secondVerifier.verify(first.clone(), 'admin_command')]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  const failed = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
  assert.equal(failed.reason.code, 'replay');
  const crossEntry = await f.request(access, 'admin_mcp', {}, { nonce: n, jti });
  await assert.rejects(secondVerifier.verify(crossEntry, 'admin_mcp'), (e: unknown) => e instanceof AdminProofError && e.code === 'replay');
  const restarted = new AdminRequestVerifier(f.jwt, shared);
  await assert.rejects(restarted.verify(first.clone(), 'admin_command'), (e: unknown) => e instanceof AdminProofError && e.code === 'replay');
  assert.equal(isAdminAdmission(await restarted.verify(await f.request(access, 'admin_mcp', {}, { nonce: n }), 'admin_mcp')), true);
});

test('admin-dpop-verifier-unit: reject Bearer, class/cnf, key, hash, method, configured URI, time, nonce and ambiguous headers before authority', async () => {
  const shared = store(), f = await cryptoFixture(shared), access = await f.token(), n = await nonce(f, access);
  for (const changes of [{ grant_class: undefined }, { cnf: undefined }, { aud: [ADMIN_MCP_URI] }, { grant_id: undefined }, { admin_grant_id: undefined }, { admin_identity_id: undefined }, { scope: 'mcp' }, { registry_version: 1 }, { exp: f.claims.iat + 301 }, { iat: f.claims.iat + 1 }, { nbf: f.claims.iat + 1 }]) {
    await assert.rejects(f.verifier.verify(await f.request(await f.token(changes), 'admin_command', {}, { nonce: n }), 'admin_command'), AdminTokenError);
  }
  await assert.rejects(f.verifier.verify(await f.request(access, 'admin_command', {}, { nonce: n }, 'Bearer'), 'admin_command'), AdminTokenError);
  for (const changes of [{ ath: 'wrong' }, { htm: 'GET' }, { htu: ADMIN_MCP_URI }, { htu: `${ADMIN_COMMAND_URI}?x=1` }, { htu: 'https://evil.example/functions/v1/command' }, { iat: f.claims.iat - 61 }, { iat: f.claims.iat + 6 }, { jti: '' }, { nonce: 'K'.repeat(43) }]) {
    await assert.rejects(f.verifier.verify(await f.request(access, 'admin_command', {}, { nonce: n, ...changes }), 'admin_command'), AdminProofError);
  }
  for (const header of [{ typ: 'JWT' }, { alg: 'none' }, { crit: ['x'] }, { jku: 'https://evil.example' }, { jwk: { ...f.publicKey, d: 'private' } }]) {
    const req = await f.request(access, 'admin_command', {}, { nonce: n });
    req.headers.set('dpop', await f.proof(access, 'admin_command', { nonce: n }, header));
    await assert.rejects(f.verifier.verify(req, 'admin_command'), AdminProofError);
  }
  const attacker = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
  const wrong = await f.request(access, 'admin_command', {}, { nonce: n });
  wrong.headers.set('dpop', await f.proof(access, 'admin_command', { nonce: n }, {}, attacker.privateKey));
  await assert.rejects(f.verifier.verify(wrong, 'admin_command'), AdminProofError);
  const duplicate = await f.request(access, 'admin_command', {}, { nonce: n }); duplicate.headers.append('dpop', duplicate.headers.get('dpop')!);
  await assert.rejects(f.verifier.verify(duplicate, 'admin_command'), AdminProofError);
  const duplicateAuth = await f.request(access, 'admin_command', {}, { nonce: n }); duplicateAuth.headers.append('authorization', duplicateAuth.headers.get('authorization')!);
  await assert.rejects(f.verifier.verify(duplicateAuth, 'admin_command'), AdminTokenError);
  assert.equal(isAdminAdmission({ token: f.claims, digest: await adminTokenDigest(access) }), false);
  assert.equal(isAdminAdmission(await f.verifier.verify(await f.request(access, 'admin_command', {}, { nonce: n }, 'dPoP', { forwarded: 'host=evil.example', 'x-forwarded-host': 'evil.example' }), 'admin_command')), true);
});

test('admin-boundary-isolation: denial classification recognizes both schemes while ordinary credentials remain ordinary', async () => {
  const f = await cryptoFixture(store()), access = await f.token();
  for (const scheme of ['Bearer','DPoP','dPoP']) assert.equal(presentsAdminCredential(new Request(ADMIN_MCP_URI, { headers: { authorization: `${scheme} ${access}` } })), true);
  for (const credential of ['swm_adm_' + 'a'.repeat(43), 'swm_adr_' + 'b'.repeat(43)]) assert.equal(presentsAdminCredential(new Request(ADMIN_MCP_URI, { headers: { authorization: `Bearer ${credential}` } })), true);
  assert.equal(presentsAdminCredential(new Request(ADMIN_MCP_URI, { headers: { authorization: `Bearer ${await f.token({ aud: 'https://mcp.commonswarm.com/mcp', grant_class: 'hosted_mcp' })}` } })), false);
  assert.equal(presentsAdminCredential(new Request(ADMIN_MCP_URI, { headers: { authorization: 'Bearer swm_worker_test' } })), false);
});

test('admin-dpop-verifier-unit: unavailable proof storage and nonce persistence fail closed without an in-memory fallback', async () => {
  const broken = { admit: async () => { throw new Error('unavailable'); }, registerNonce: async () => false };
  const f = await cryptoFixture(broken), access = await f.token();
  await assert.rejects(f.verifier.verify(await f.request(access), 'admin_command'), AdminProofError);
  const missing = await cryptoFixture({ ...broken, admit: async () => 'nonce_required' as const });
  await assert.rejects(missing.verifier.verify(await missing.request(await missing.token()), 'admin_command'), (e: unknown) => e instanceof AdminProofError && e.code === 'invalid_dpop');
});


test('unavailable JWKS, empty or mismatched URL pins never admit an admin token; pinned issuer positive control succeeds', async () => {
  const shared=store(), f=await cryptoFixture(shared), access=await f.token();
  const jwks = (url: string, emptyKeys = false) => {
    const response = new Response(JSON.stringify({ keys: emptyKeys ? [] : [f.issuerJwk] }));
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  // Valid keys and signatures make these URL negatives reach the pin itself.
  for (const fetch of [async()=>{throw new Error('offline');},async()=>jwks(''),async()=>jwks('https://untrusted.example/jwks'),async()=>jwks('https://mcp.commonswarm.com/jwks', true),async()=>new Response(null,{status:302,headers:{location:'https://untrusted.example/jwks'}})]) {
    const verifier=new AdminRequestVerifier(new AdminJwtVerifier({fetch}),shared);
    await assert.rejects(verifier.verify(await f.request(access),'admin_command'),AdminTokenError);
  }
  assert.equal(shared.calls,0);
  const n=await nonce(f,access);
  assert.equal(isAdminAdmission(await f.verifier.verify(await f.request(access,'admin_command',{}, {nonce:n}),'admin_command')),true);
});

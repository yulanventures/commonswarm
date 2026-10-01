import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error TS5097: service-free verification of the real Deno boundary.
import { AdminRuntimeJwtVerifier, AdminRuntimeTokenError, ADMIN_RUNTIME_ISSUER, ADMIN_RUNTIME_JWKS_URL } from '../supabase/functions/command/admin-runtime-auth.ts';
import { ADMIN_RESOURCE, ADMIN_ACCESS_TTL_SECONDS } from '../src/protocol/admin-policy.js';

const now = 1_800_000_000;
const owner = '11111111-1111-4111-8111-111111111111';
const grant = '22222222-2222-4222-8222-222222222222';
const connection = '33333333-3333-4333-8333-333333333333';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('admin runtime proof requires a real issuer signature and exact signed admin binding', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const attacker = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'test-admin', alg: 'ES256', use: 'sig' };
  let fetches = 0;
  const verifier = new AdminRuntimeJwtVerifier({ now: () => now, fetch: async (url) => {
    assert.equal(url, ADMIN_RUNTIME_JWKS_URL);
    fetches++;
    return new Response(JSON.stringify({ keys: [jwk] }));
  } });
  const claims = { iss: ADMIN_RUNTIME_ISSUER, aud: ADMIN_RESOURCE, sub: owner, grant_id: grant,
    connection_id: connection, client_id: 'test-runtime', iat: now, exp: now + ADMIN_ACCESS_TTL_SECONDS };
  const sign = async (overrides: Record<string, unknown> = {}, headers: Record<string, unknown> = {}, key = keys.privateKey) => {
    const message = `${encode({ typ: 'at+jwt', alg: 'ES256', kid: jwk.kid, ...headers })}.${encode({ ...claims, ...overrides })}`;
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(message));
    return `${message}.${Buffer.from(signature).toString('base64url')}`;
  };
  const accepted = { owner_user_id: owner, grant_id: grant, connection_id: connection,
    client_id: 'test-runtime', resource: ADMIN_RESOURCE, expires_at: claims.exp * 1000 };
  assert.deepEqual(await verifier.verify(await sign()), accepted);
  const rejected = (error: unknown) => error instanceof AdminRuntimeTokenError && error.code === 'invalid_token';
  // Disclosed consent identifiers and even well-formed unsigned claims are not proof.
  await assert.rejects(verifier.verify(accepted as unknown as string), rejected);
  await assert.rejects(verifier.verify(`${encode({ alg: 'none' })}.${encode(claims)}.fake`), rejected);
  await assert.rejects(verifier.verify(await sign({}, {}, attacker.privateKey)), rejected);
  for (const overrides of [
    { iss: 'https://attacker.invalid' }, { aud: 'https://mcp.commonswarm.com/mcp' },
    { aud: [ADMIN_RESOURCE] }, { grant_id: undefined }, { sub: undefined },
    { connection_id: undefined }, { client_id: '' },
    { iat: now - ADMIN_ACCESS_TTL_SECONDS, exp: now },
    { exp: now + ADMIN_ACCESS_TTL_SECONDS + 1 }, { iat: now + 1 }, { nbf: now + 1 },
  ]) await assert.rejects(verifier.verify(await sign(overrides)), rejected);
  for (const headers of [
    { alg: 'HS256' }, { jku: 'https://attacker.invalid/jwks' }, { jwk },
    { typ: 'JWT' }, { crit: ['b64'], b64: false },
  ]) await assert.rejects(verifier.verify(await sign({}, headers)), rejected);
  assert.equal(fetches, 1, 'token input cannot select a key source');
  assert.deepEqual(await verifier.verify(await sign()), accepted, 'denials preserve the valid control');
});

test('admin runtime verification fails closed when the pinned key source is unavailable', async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'test-admin', alg: 'ES256', use: 'sig' };
  const message = `${encode({ typ: 'at+jwt', alg: 'ES256', kid: jwk.kid })}.${encode({ iss: ADMIN_RUNTIME_ISSUER,
    aud: ADMIN_RESOURCE, sub: owner, grant_id: grant, connection_id: connection,
    client_id: 'runtime', iat: now, exp: now + ADMIN_ACCESS_TTL_SECONDS })}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(message));
  const credential = `${message}.${Buffer.from(signature).toString('base64url')}`;
  let available = true;
  let clock = now;
  const verifier = new AdminRuntimeJwtVerifier({ now: () => clock, fetch: async () => {
    if (!available) throw new Error('offline');
    return new Response(JSON.stringify({ keys: [jwk] }));
  } });
  await verifier.verify(credential);
  clock += 61; available = false;
  await assert.rejects(verifier.verify(credential), (error: unknown) =>
    error instanceof AdminRuntimeTokenError && error.code === 'jwks_unavailable');
  available = true;
  assert.equal((await verifier.verify(credential)).grant_id, grant);
});

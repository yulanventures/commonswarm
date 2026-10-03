import { randomUUID } from 'node:crypto';
// @ts-expect-error TS5097 real Deno verifier
import { AdminJwtVerifier, AdminRequestVerifier, adminTokenDigest, base64url, ADMIN_COMMAND_URI, ADMIN_MCP_URI } from '../../supabase/functions/_shared/admin-oauth-auth.ts';
import type { AdminProofStore } from '../../supabase/functions/_shared/admin-oauth-auth.ts';

export async function cryptoFixture(store: AdminProofStore, now = Math.floor(Date.now() / 1000)) {
  const issuer = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
  const possession = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', possession.publicKey);
  const issuerJwk = { ...await crypto.subtle.exportKey('jwk', issuer.publicKey), kid: 'edge-test', alg: 'ES256', use: 'sig' };
  const jkt = base64url(await adminTokenDigest(JSON.stringify({ crv: 'P-256', kty: 'EC', x: publicKey.x, y: publicKey.y })));
  const claims = { iss: 'https://mcp.commonswarm.com', aud: ADMIN_MCP_URI, sub: randomUUID(),
    grant_id: `provider-${randomUUID()}`, grant_class: 'delegated_admin', admin_grant_id: randomUUID(),
    admin_identity_id: randomUUID(), connection_id: randomUUID(), client_id: 'https://client.example',
    scope: 'admin:read', registry_version: 2, manifest_digest: 'a'.repeat(64), cnf: { jkt }, jti: randomUUID(), iat: now, exp: now + 300 };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const sign = async (header: unknown, payload: unknown, key: CryptoKey) => {
    const input = `${encode(header)}.${encode(payload)}`;
    return `${input}.${base64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(input))))}`;
  };
  const token = (overrides = {}, headers = {}, key = issuer.privateKey) => sign({ typ: 'at+jwt', alg: 'ES256', kid: 'edge-test', ...headers }, { ...claims, ...overrides }, key);
  const proof = (access: string, surface = 'admin_command', overrides = {}, headers = {}, key = possession.privateKey) => sign(
    { typ: 'dpop+jwt', alg: 'ES256', jwk: publicKey, ...headers },
    { htm: 'POST', htu: surface === 'admin_command' ? ADMIN_COMMAND_URI : ADMIN_MCP_URI, iat: now, jti: randomUUID(),
      ath: '', ...overrides }, key).then(async unsigned => {
      // Re-sign with the independently computed access-token hash.
      const body = JSON.parse(Buffer.from(unsigned.split('.')[1]!, 'base64url').toString());
      if (!Object.hasOwn(overrides, 'ath')) body.ath = base64url(await adminTokenDigest(access));
      return sign({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicKey, ...headers }, body, key);
    });
  const jwt = new AdminJwtVerifier({ now: () => now, fetch: async url => {
    if (url !== 'https://mcp.commonswarm.com/jwks') throw new Error('unexpected_key_source');
    const response = new Response(JSON.stringify({ keys: [issuerJwk] }));
    Object.defineProperty(response, 'url', { value: String(url) });
    return response;
  } });
  const verifier = new AdminRequestVerifier(jwt, store);
  const request = async (access: string, surface: 'admin_command' | 'admin_mcp' = 'admin_command', body: unknown = {}, overrides = {}, scheme = 'DPoP', extra: Record<string,string> = {}) => new Request(surface === 'admin_command' ? ADMIN_COMMAND_URI : ADMIN_MCP_URI, {
    method: 'POST', headers: { authorization: `${scheme} ${access}`, dpop: await proof(access, surface, overrides), ...extra }, body: JSON.stringify(body),
  });
  return { token, proof, request, jwt, verifier, claims, jkt, publicKey, possession, issuer, issuerJwk, sign };
}

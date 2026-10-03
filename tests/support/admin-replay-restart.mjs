// CI-only fresh verifier process. Configuration/proofs arrive over stdin and
// remain in memory; stdout contains only a fixed result, never raw exceptions.
import postgres from 'npm:postgres@3.4.9';
import { AdminJwtVerifier, AdminProofError } from '../../supabase/functions/_shared/admin-oauth-auth.ts';
import { createAdminRequestVerifier } from '../../supabase/functions/_shared/admin-oauth-db.ts';
let db;
try {
  const config = JSON.parse(await new Response(Deno.stdin.readable).text());
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.databaseUrl).hostname)) throw new Error('local stack required');
  db = postgres(config.databaseUrl, { prepare: false, max: 1 });
  const jwt = new AdminJwtVerifier({ fetch: async url => {
    if (url !== 'https://mcp.commonswarm.com/jwks') throw new Error('unexpected issuer');
    const response = new Response(JSON.stringify({ keys: [config.issuerJwk] }));
    Object.defineProperty(response, 'url', { value: String(url) });
    return response;
  } });
  const verifier = createAdminRequestVerifier(db, jwt);
  for (const item of config.replays) {
    let refused = false;
    try { await verifier.verify(new Request(item.url, { method: 'POST', headers: item.headers }), item.surface); }
    catch (error) { refused = error instanceof AdminProofError && error.code === 'replay'; }
    if (!refused) throw new Error('restart released proof');
  }
  const fresh = config.fresh;
  await verifier.verify(new Request(fresh.url, { method: 'POST', headers: fresh.headers }), fresh.surface);
  console.log('ADMIN_REPLAY_RESTART_OK');
} catch {
  console.log('ADMIN_REPLAY_RESTART_FAILED');
  Deno.exitCode = 1;
} finally { await db?.end({ timeout: 2 }); }

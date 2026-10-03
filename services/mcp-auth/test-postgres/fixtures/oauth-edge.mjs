// Test-only loopback bridge to the actual Deno MCP and management entry points.
// Credentials arrive in a protected file, never arguments or environment values.
const config = JSON.parse(await Deno.readTextFile(Deno.args[0]));
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.databaseUrl).hostname)) {
  throw new Error('local migrated test database required');
}
const settings = new Map([
  ['SWARM_ENV', 'test'],
  ['SWARM_DATABASE_URL', config.databaseUrl],
  ['SUPABASE_URL', config.gotrueUrl],
  ['SUPABASE_ANON_KEY', 'synthetic-contract-key'],
  ['SWARM_MCP_PUBLIC_ENABLED', '1'],
]);
// Lexical equivalent of build-management.mjs: keep the test database URL out of
// process.env, while importing the unchanged Deno production compositions.
const originalEnvGet = Deno.env.get;
Deno.env.get = name => settings.has(name) ? settings.get(name) : originalEnvGet(name);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === 'https://mcp.commonswarm.com/jwks') {
    const result = await originalFetch(`${config.authOrigin}/jwks`, options);
    // Preserve the verifier's pinned URL contract while forwarding only the
    // fixture's public JWKS; no JWT is replaced or synthesized here.
    return new Response(await result.arrayBuffer(), {
      status: result.status, headers: result.headers,
    });
  }
  throw new Error('unexpected fixture network request');
};
const { db, handleHostedManagementCommand } = await import('../../../../supabase/functions/command/index.ts');
const { handleRequest: mcp } = await import('../../../../supabase/functions/mcp/index.ts');
const server = Deno.serve({
  hostname: '127.0.0.1', port: 0,
  onListen: ({ port }) => console.log(`OAUTH_EDGE_PORT=${port}`),
}, async request => {
  if (request.headers.get('x-contract-bridge') !== config.bridgeKey) {
    return new Response(null, { status: 403 });
  }
  const path = new URL(request.url).pathname;
  if (path === '/management') {
    const { input, identity } = await request.json();
    const result = await handleHostedManagementCommand(input, identity);
    return Response.json(result);
  }
  if (path === '/workspaces') {
    const identity = await request.json();
    if (identity.identityVerified !== true) return new Response(null, { status: 403 });
    const rows = await db.begin(async tx => {
      await tx`SELECT set_config('role', 'swarm_read', true),
        set_config('search_path', 'swarm_read, swarm, pg_catalog', true),
        set_config('request.jwt.claims', ${JSON.stringify({ sub: identity.userId, role: 'authenticated' })}, true)`;
      return await tx`SELECT workspace_id AS id, name FROM swarm_read.workspaces ORDER BY name, workspace_id`;
    });
    return Response.json(rows);
  }
  if (path === '/shutdown') {
    setTimeout(async () => { await db.end({ timeout: 2 }); await server.shutdown(); Deno.exit(0); }, 10);
    return new Response(null, { status: 204 });
  }
  // initialize and tools/list use the same handler and ES256/JWKS verifier as
  // the hosted edge. The bridge header is ignored by the production handler.
  return await mcp(request);
});

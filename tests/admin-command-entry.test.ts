import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

/** Bundle the actual command entry with inert transport dependencies. No Deno
 * worker, socket, database, GoTrue, browser or production service is started. */
async function commandEntry() {
  const bundled = await build({
    entryPoints: ['supabase/functions/command/index.ts'], bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    banner: { js: `
      const poolOptions = []; let humanAuthCalls = 0;
      const settings = { SWARM_ENV: 'test', SWARM_DATABASE_URL: 'postgres://127.0.0.1:1/unused',
        SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'inert-test-value' };
      const Deno = { env: { get: name => settings[name] },
        serve: () => { throw new Error('import started a server'); } };` },
    footer: { js: `export { poolOptions }; export function humanAuthCount() { return humanAuthCalls; }\n// ${randomUUID()}` },
    plugins: [{ name: 'inert-edge-transports', setup(builder) {
      builder.onResolve({ filter: /^npm:/ }, args => ({ path: args.path, namespace: 'inert-edge' }));
      builder.onLoad({ filter: /.*/, namespace: 'inert-edge' }, args => {
        if (args.path === 'npm:postgres@3.4.9') return { contents: `
          export default function postgres(_url, options) {
            poolOptions.push(options);
            const sql = async () => [];
            sql.begin = async (...args) => args.at(-1)(sql);
            return sql;
          }`, loader: 'js' };
        if (args.path === 'npm:@supabase/supabase-js@2.110.8') return { contents: `
          export function createClient() { return { auth: { async getUser() {
            humanAuthCalls++; return { data: { user: null }, error: { message: 'inert refusal' } };
          }, async getClaims() { return { data: null, error: { message: 'inert refusal' } }; } } }; }`, loader: 'js' };
        throw new Error(`unexpected dependency: ${args.path}`);
      });
    } }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`) as {
    handleRequest(request: Request): Promise<Response>;
    poolOptions: Array<{ max: number }>;
    humanAuthCount(): number;
  };
}
const resource = 'https://api.commonswarm.com/admin';
const token = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.invalid`;
function request(authorization: string, body: object = {}) {
  return new Request('https://api.commonswarm.com/functions/v1/command', {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('ordinary command import and requests create only the existing pool; first admin request creates and reuses its proof pool', async () => {
  const entry = await commandEntry();
  assert.deepEqual(entry.poolOptions.map(o => o.max), [2]);
  assert.equal((await entry.handleRequest(request('Bearer swm_agt_ordinary'))).status, 400);
  assert.deepEqual(entry.poolOptions.map(o => o.max), [2]);
  const admin = `DPoP ${token({ grant_class: 'delegated_admin', aud: resource })}`;
  assert.equal((await entry.handleRequest(request(admin))).status, 401);
  assert.deepEqual(entry.poolOptions.map(o => o.max), [2, 1]);
  assert.equal((await entry.handleRequest(request(admin))).status, 401);
  assert.deepEqual(entry.poolOptions.map(o => o.max), [2, 1]);
});

test('ordinary DPoP and long Bearer retain command validation and GoTrue; only admin resource or credential enters admin admission', async () => {
  const entry = await commandEntry();
  // Ordinary DPoP reaches command validation (not the admin 401).
  const ordinary = `DPoP ${token({ grant_class: 'hosted_mcp', aud: 'https://mcp.commonswarm.com/mcp' })}`;
  assert.equal((await entry.handleRequest(request(ordinary))).status, 400);
  const longBearer = `Bearer ${token({ aud: 'authenticated', padding: 'x'.repeat(17 * 1024) })}`;
  const body = { command_id: 'ordinary-auth-path', command: { kind: 'post_signal' } };
  assert.equal((await entry.handleRequest(request(longBearer, body))).status, 401);
  assert.equal(entry.humanAuthCount(), 1, 'long Bearer reaches existing GoTrue authentication');
  assert.equal((await entry.handleRequest(request('Bearer human-session', { ...body, resource }))).status, 401);
  assert.equal(entry.humanAuthCount(), 2, 'human account resource keeps its own authentication');
  assert.deepEqual(entry.poolOptions.map(o => o.max), [2]);
  assert.equal((await entry.handleRequest(request(ordinary, { resource }))).status, 401);
  assert.deepEqual(entry.poolOptions.map(o => o.max), [2, 1], 'admin resource selects the closed verifier');
  for (const scheme of ['Bearer', 'DPoP']) {
    assert.equal((await entry.handleRequest(request(`${scheme} ${token({ grant_class: 'delegated_admin' })}`))).status, 401);
  }
  assert.equal(entry.humanAuthCount(), 2, 'admin credentials never enter GoTrue');
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

/** Bundle the actual command entry with inert transport dependencies. No Deno
 * worker, socket, database, GoTrue, browser or production service is started. */
async function commandEntry(discoveryFailure: { code: string; detail: string } | null = null) {
  const bundled = await build({
    entryPoints: ['supabase/functions/command/index.ts'], bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    banner: { js: `
      const poolOptions = []; let humanAuthCalls = 0;
      const failureLogs = [];
      const console = { ...globalThis.console, error: (...args) => failureLogs.push(args) };
      let logClock = 0;
      const performance = { now: () => logClock };
      const discoveryFailure = ${JSON.stringify(discoveryFailure)};
      const transactionStats = { begins: 0, rollbacks: 0, discoveries: 0, diagnostics: 0 };
      const settings = { SWARM_ENV: 'test', SWARM_DATABASE_URL: 'postgres://127.0.0.1:1/unused',
        SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'inert-test-value' };
      const Deno = { env: { get: name => settings[name] },
        serve: () => { throw new Error('import started a server'); } };` },
    footer: { js: `export { poolOptions, transactionStats, failureLogs };
      export function advanceLogClock(ms) { logClock += ms; }
      export function humanAuthCount() { return humanAuthCalls; }\n// ${randomUUID()}` },
    plugins: [{ name: 'inert-edge-transports', setup(builder) {
      builder.onResolve({ filter: /^npm:/ }, args => ({ path: args.path, namespace: 'inert-edge' }));
      builder.onLoad({ filter: /.*/, namespace: 'inert-edge' }, args => {
        if (args.path === 'npm:postgres@3.4.9') return { contents: `
          export default function postgres(_url, options) {
            poolOptions.push(options);
            const sql = async (parts) => {
              const query = parts.join('?');
              if (query.includes('INSERT INTO swarm.command_failures')) transactionStats.diagnostics++;
              if (discoveryFailure && query.includes('swarm.discover_local_target_ids')) {
                transactionStats.discoveries++;
                throw Object.assign(new Error('untrusted discovery diagnostic'), discoveryFailure);
              }
              if (discoveryFailure && query.includes('SELECT m.role')) return [{ role: 'owner' }];
              if (discoveryFailure && query.includes('AS ok')) return [{ ok: true }];
              return [];
            };
            sql.begin = async (...args) => {
              transactionStats.begins++;
              try { return await args.at(-1)(sql); }
              catch (error) { transactionStats.rollbacks++; throw error; }
            };
            return sql;
          }`, loader: 'js' };
        if (args.path === 'npm:@supabase/supabase-js@2.110.8') return { contents: `
          export function createClient() { return { auth: { async getUser() {
            humanAuthCalls++;
            return discoveryFailure
              ? { data: { user: { id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.test', email_confirmed_at: '2026-01-01' } }, error: null }
              : { data: { user: null }, error: { message: 'inert refusal' } };
          }, async getClaims() { return discoveryFailure
            ? { data: { claims: {} }, error: null }
            : { data: null, error: { message: 'inert refusal' } }; } } }; }`, loader: 'js' };
        throw new Error(`unexpected dependency: ${args.path}`);
      });
    } }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`) as {
    handleRequest(request: Request): Promise<Response>;
    poolOptions: Array<{ max: number }>;
    humanAuthCount(): number;
    failureLogs: unknown[][];
    advanceLogClock(ms: number): void;
    transactionStats: { begins: number; rollbacks: number; discoveries: number; diagnostics: number };
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

// R6 product regression: exercise the real HTTP/transaction/discovery path with
// an inert SQL transport. Real malformed-row and no-write proof lives in the
// renewal permanence harness; this protects the error-to-HTTP boundary offline.
test('queue binding refusal logs a fixed, rate-bounded counter and returns generic 403 after rollback without retry or failure diagnostic', async () => {
  for (const failure of [
    { code: '22023', detail: 'LOCAL_DISCOVERY_BINDING', status: 403 },
    { code: '22023', detail: 'OTHER_INVALID_PARAMETER', status: 500 },
    { code: 'XX000', detail: 'LOCAL_DISCOVERY_BINDING', status: 500 },
    { code: '40001', detail: 'unowned_serialization_failure', status: 500 },
  ]) {
    const entry = await commandEntry({ code: failure.code, detail: failure.detail });
    const refuse = () => entry.handleRequest(request('Bearer human-session', {
      command_id: randomUUID(), client_version: '0.1.0',
      workspace_id: '20000000-0000-4000-8000-000000000001', stream: { kind: 'workspace' },
      command: { kind: 'household_tool', tool: 'todo_queue', arguments: {
        seat: 'seat_0000000000000000000000', principal_id: '30000000-0000-4000-8000-000000000001',
      } },
    }));
    const response = await refuse();
    assert.equal(response.status, failure.status, `${failure.code}/${failure.detail}`);
    assert.deepEqual(await response.json(), { error: failure.status === 403 ? 'forbidden' : 'internal_error' });
    assert.deepEqual(entry.transactionStats, {
      begins: 1, rollbacks: 1, discoveries: 1, diagnostics: failure.status === 403 ? 0 : 1,
    });
    if (failure.status === 403) {
      const event = {
        event: 'command_request_failure', command_kind: 'local_discovery',
        outcome: 'authz', reason: 'local_discovery_binding', db_code: '22023', count: 1,
      };
      const events = () => entry.failureLogs.map(args => {
        assert.equal(args.length, 1);
        assert.equal(typeof args[0], 'string');
        return JSON.parse(args[0] as string);
      });
      assert.deepEqual(events(), [event]);
      entry.advanceLogClock(59_999);
      for (let i = 0; i < 3; i++) {
        const repeated = await refuse();
        assert.equal(repeated.status, 403);
        assert.deepEqual(await repeated.json(), { error: 'forbidden' });
      }
      assert.equal(entry.failureLogs.length, 1, 'a burst cannot flood the log');
      entry.advanceLogClock(1);
      const next = await refuse();
      assert.equal(next.status, 403);
      assert.deepEqual(await next.json(), { error: 'forbidden' });
      assert.deepEqual(events(), [
        event, { ...event, count: 5 },
      ], 'the next sample includes every suppressed refusal in its cumulative count');
      assert.deepEqual(entry.transactionStats, { begins: 5, rollbacks: 5, discoveries: 5, diagnostics: 0 });
    }
  }
});

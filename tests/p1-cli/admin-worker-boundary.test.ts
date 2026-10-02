import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

test('real worker HTTP handlers refuse admin credentials before parsing, authentication, or database work', () => {
  const run = spawnSync('deno', ['run', '--no-lock', '--node-modules-dir=manual', '--config', 'supabase/functions/command/deno.json',
    '--allow-read', '--allow-env', 'tests/support/admin-worker-boundary.mjs'], {
    encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}) },
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /ADMIN_WORKER_BOUNDARY_OK/u);
});

test('release admin smoke retains only redacted responses on PASS and FAIL', (t) => {
  const plan = readFileSync('docs/evidence/2026-10-02-cd-edge-release/RELEASE.md', 'utf8');
  const block = [...plan.matchAll(/^```sh\n(.*?)^```$/gms)]
    .map(match => match[1]!).find(value => value.startsWith('# step: cd-admin-smoke\n'));
  assert.ok(block);
  const scripts = [...block.matchAll(/<<'PYCODE'\n(.*?)\nPYCODE/gms)].map(match => match[1]!);
  assert.equal(scripts.length, 2);
  const directory = mkdtempSync('/private/tmp/cdrel-smoke-test.');
  t.after(() => {
    assert.match(directory, /^\/private\/tmp\/cdrel-smoke-test\.[A-Za-z0-9]+$/u);
    assert.equal(realpathSync(directory), directory);
    const cleanup = spawnSync('rm', ['-rf', '--', directory], { encoding: 'utf8' });
    assert.equal(cleanup.status, 0, `guarded cleanup refused ${directory}: ${cleanup.stderr}`);
  });
  const fixture = `import email.message,json,sys,urllib.request
case=sys.argv[2]
class Response:
 def __init__(self,health):
  self.code=200 if health else 403
  self.headers=email.message.Message()
  self.headers['Content-Type']='application/json'
  self.headers['Authorization']='DO_NOT_RETAIN_HEADER'
  self.headers['Server']='Caddy'
  self.body=json.dumps({'status':'ok'} if health else {'error':'credential_kind_forbidden','private':'DO_NOT_RETAIN_BODY'}).encode()
  if not health:
   if case=='wrong': self.body=b'{"error":"forbidden","private":"DO_NOT_RETAIN_BODY"}'
   if case=='unsafe': self.body=b'{"error":"Bearer DO_NOT_RETAIN_BODY"}'
   if case=='malformed': self.body=b'DO_NOT_RETAIN_BODY'
   if case=='html': self.headers.replace_header('Content-Type','text/html'); self.body=b'DO_NOT_RETAIN_BODY'
   if case=='oversize': self.body=b'x'*131073
   if case=='cloudflare': self.headers.replace_header('Server','cloudflare'); self.body=b'error code: 1010'
   if case=='cloudflare_json': self.headers.replace_header('Server','cloudflare'); self.body=b'{"error":"forbidden"}'
   if case=='cloudflare_pass': self.headers.replace_header('Server','cloudflare')
   if case=='unsafe_server': self.headers.replace_header('Server','DO_NOT_RETAIN_HEADER')
 def __enter__(self): return self
 def __exit__(self,*args): pass
 def read(self,limit): return self.body[:limit]
class Opener:
 def open(self,req,timeout):
  if req.full_url=='http://127.0.0.1:9000/functions/v1/read': assert req.get_header('Host')=='api.commonswarm.com'
  if req.full_url.startswith('https://'): assert req.get_header('User-agent')=='curl/8.7.1'
  if case=='transport' and req.full_url.endswith('/read'): raise RuntimeError('DO_NOT_RETAIN_EXCEPTION')
  return Response(req.full_url.endswith('/health'))
urllib.request.build_opener=lambda *args: Opener()
`;
  for (const scenario of ['pass', 'wrong', 'unsafe', 'malformed', 'html', 'oversize', 'transport', 'cloudflare', 'cloudflare_json', 'cloudflare_pass', 'unsafe_server']) {
    const receipt = join(directory, `${scenario}.json`);
    const run = spawnSync('python3', ['-c', fixture + '\n' + scripts[1], receipt, scenario], {
      encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(run.error);
    const passing = ['pass', 'cloudflare_pass', 'unsafe_server'].includes(scenario);
    assert.equal(run.status, passing ? 0 : 1, run.stderr);
    const saved = readFileSync(receipt, 'utf8');
    assert.equal((saved + run.stdout + run.stderr).includes('DO_NOT_RETAIN'), false, scenario);
    const value = JSON.parse(saved);
    assert.equal(value.result, passing ? 'PASS' : 'FAIL');
    assert.equal(value.responses.length, 3);
    assert.equal(value.responses[0].status, 200, 'positive control must remain recorded');
    for (const response of value.responses) {
      assert.deepEqual(Object.keys(response).sort(), ['content_type', 'error', 'probe', 'server', 'size', 'status']);
    }
    assert.equal(value.responses[2].error, passing ? 'credential_kind_forbidden' : ['wrong', 'cloudflare_json'].includes(scenario) ? 'forbidden' : null);
    if (scenario === 'wrong') assert.match(run.stderr, /FAIL cd-admin-smoke: public_admin error=forbidden; STOP/u);
    if (scenario.startsWith('cloudflare')) assert.equal(value.responses[2].server, 'cloudflare');
    if (['cloudflare', 'cloudflare_json'].includes(scenario)) assert.match(run.stderr, /FAIL cloudflare_block/u);
    if (scenario === 'unsafe_server') assert.equal(value.responses[2].server, 'other');
    if (!passing) assert.match(run.stderr, /"content_type":.*"server":.*"size":.*"status":/u);
    if (scenario === 'oversize') assert.equal(value.responses[2].size, 131073);
  }
});

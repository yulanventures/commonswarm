/** Execute the marked W5 measurement block, with only external observations stubbed.
 * The other assigned controls have plan defects recorded in the lane's RESULT.md;
 * a bare assertion/exit is not the required block-owned STOP/FAIL diagnostic.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';

const plan = readFileSync(resolve('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'), 'utf8');
const blocks = [...plan.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!);
const block = (step: string) => {
  const found = blocks.filter(source => source.startsWith(`# step: ${step}\n`));
  assert.equal(found.length, 1, `one complete ${step} block`);
  return found[0]!;
};
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const temporaryRoot = realpathSync(tmpdir());
const scratch = realpathSync(mkdtempSync(join(temporaryRoot, 'admin-w45-')));
const realHome = realpathSync(homedir());
assert.equal(dirname(scratch), temporaryRoot);
assert.ok(scratch !== realHome && !scratch.startsWith(realHome + sep));
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
after(() => {
  assert.equal(dirname(scratch), temporaryRoot);
  assert.match(scratch.slice(temporaryRoot.length + 1), /^admin-w45-[A-Za-z0-9]{6}$/);
  // Use the machine's guarded rm; a refused cleanup is a failure, never bypassed.
  const cleanup = spawnSync('rm', ['-r', '--', scratch], { encoding: 'utf8' });
  assert.equal(cleanup.status, 0, `fixture cleanup refused ${scratch}: ${cleanup.stderr}`);
});

const client = { client_id: 'https://commonswarm.com/oauth/c1-smoke/client.json',
  redirect_uris: ['https://commonswarm.com/oauth/c1-smoke/callback'] };
const dispatch = `#!/bin/bash
set -eu
name=\${0##*/}
{ printf '%s' "$name"; printf ' %q' "$@"; printf '\\n'; } >>"$W45_COMMAND_LOG"
case "$name" in
 python3) exec /usr/bin/python3 "$W45_PYTHON_WRAPPER" "$@";;
 node)
  if test "$#" = 2 && test "$1" = scripts/admin-smoke.mjs && test "$2" = --print-client-metadata; then
   printf '%s\\n' "$W45_CLIENT"; exit 0
  fi;;
esac
printf 'UNMODELLED %s\\n' "$name" >&2
exit 97
`;
// The wrapper substitutes the HTTP transport, not the release block's predicates.
// Unexpected URLs, methods, origins, and subprocesses are refused without network I/O.
const pythonWrapper = `
import json,os,pathlib,subprocess,sys,urllib.request
sys.argv=sys.argv[1:]
assert sys.argv[0]=='-', 'unmodelled Python invocation'
fixture=json.loads(pathlib.Path(os.environ['W45_HTTP_FIXTURE']).read_text())
def observe(request, timeout):
    assert timeout==15
    url=request.full_url; method=request.get_method()
    with open(os.environ['W45_HTTP_LOG'],'a') as log:
        log.write(json.dumps({'url':url,'method':method,'headers':dict(request.header_items())})+'\\n')
    if url=='https://mcp.commonswarm.com/admin/gate':
        assert method in ('GET','HEAD') and request.get_header('Origin')=='https://commonswarm.com'
        body=json.dumps({'state':fixture['gate_state']}).encode() if method=='GET' else b''
        headers={'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'}
    elif url==${JSON.stringify(client.client_id)}:
        assert method=='GET'
        body=json.dumps(fixture['client']).encode(); headers={'Content-Type':'application/json'}
    elif url==${JSON.stringify(client.redirect_uris[0])}:
        assert method=='GET'
        body=b'<!doctype html>'; headers={'Content-Type':'text/html'}
    else:
        raise RuntimeError('unmodelled HTTP request')
    class Response:
        status=200
        def __enter__(self): return self
        def __exit__(self,*args): return False
        def read(self,limit): return body[:limit]
    r=Response(); r.headers=headers; return r
urllib.request.urlopen=observe
def refuse(*args,**kwargs): raise RuntimeError('unmodelled external operation')
urllib.request.build_opener=refuse
real_output=subprocess.check_output; real_run=subprocess.run; real_popen=subprocess.Popen
def popen(args, **kwargs):
    if args!=['node','scripts/admin-smoke.mjs','--print-client-metadata']:
        raise RuntimeError('unmodelled subprocess')
    return real_popen(args,**kwargs)
subprocess.Popen=popen
def command(args, **kwargs):
    if args!=['node','scripts/admin-smoke.mjs','--print-client-metadata']:
        raise RuntimeError('unmodelled subprocess')
    return real_output(args,**kwargs)
subprocess.check_output=command
def run_command(args, **kwargs):
    if args!=['node','scripts/admin-smoke.mjs','--print-client-metadata']:
        raise RuntimeError('unmodelled subprocess')
    return real_run(args,**kwargs)
subprocess.run=run_command; subprocess.call=refuse; subprocess.check_call=refuse
exec(compile(sys.stdin.read(),'<ai-w5-closed>','exec'))
`;

function fixture() {
  const root = mkdtempSync(join(scratch, 'case-'));
  const site = join(root, 'site'), bin = join(root, 'bin'), receipts = join(root, 'receipts');
  mkdirSync(site); mkdirSync(bin);
  writeFileSync(join(site, 'index.html'), '<!doctype html>\n');
  const manifest = JSON.stringify([{ path: 'index.html', sha256: hash(readFileSync(join(site, 'index.html'))) }]);
  writeFileSync(join(site, 'manifest.json'), manifest);
  const goodClose = `CLOSED=yes\nOUTCOME=released\nPIN_RELEASED=yes\nMANIFEST_SHA256=${hash(manifest)}\n`;
  writeFileSync(join(site, 'CLOSE.txt'), goodClose);
  const inputs = join(root, 'inputs.json');
  const data = { release_sha: 'a'.repeat(40), window: 'W5', window_id: 'Fix123' };
  writeFileSync(inputs, JSON.stringify(data));
  const http = join(root, 'http.json');
  writeFileSync(http, JSON.stringify({ gate_state: 'closed', client }));
  const wrapper = join(root, 'transport.py'); writeFileSync(wrapper, pythonWrapper);
  writeFileSync(join(bin, '_dispatch'), dispatch, { mode: 0o700 });
  for (const name of ['python3', 'node', 'ssh', 'psql', 'docker', 'curl', 'caddy', 'systemctl', 'sudo',
    'git', 'npm', 'npx', 'open', 'osascript', 'wget', 'op']) symlinkSync('_dispatch', join(bin, name));
  const commands = join(root, 'commands.log'), requests = join(root, 'http.log');
  writeFileSync(commands, ''); writeFileSync(requests, '');
  const step = block('ai-w5-closed');
  const productionRoot = '/Users/yulanbot/work/hm37-live-release';
  assert.equal(step.split(productionRoot).length - 1, 1, 'one output-root fixture rewrite');
  const source = step.split(productionRoot).join(receipts);
  const later = join(root, 'later.txt');
  const run = () => spawnSync('/bin/bash', [], {
    input: source + `\nprintf 'later side effect\\n' >${quote(later)}\n`, encoding: 'utf8', timeout: 10_000,
    cwd: root, env: { ...process.env, PATH: bin, PYTHONDONTWRITEBYTECODE: '1',
      INPUTS_FILE: inputs, SITE_EVIDENCE: site, W45_COMMAND_LOG: commands, W45_HTTP_LOG: requests,
      W45_HTTP_FIXTURE: http, W45_PYTHON_WRAPPER: wrapper, W45_CLIENT: JSON.stringify(client) },
  });
  return { site, goodClose, commands, requests, later, run,
    closedRoot: join(receipts, `${data.release_sha}-W5-${data.window_id}`) };
}

test('site-build-qa / reviewed-browser-ownership-close-before-W5-close: fails closed on an unreleased ownership close', () => {
  // Reaching the same complete block successfully prevents an unrelated harness denial
  // from being mistaken for an ownership refusal.
  const good = fixture(), admitted = good.run();
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.match(admitted.stdout, /PASS W5 site ownership close and outside GET\/HEAD gate CLOSED/);
  assert.ok(existsSync(good.later));
  assert.equal(JSON.parse(readFileSync(join(good.closedRoot, 'W5-closed.json'), 'utf8')).site_ownership_close, 'PASS');
  assert.ok(existsSync(join(good.closedRoot, 'inputs.json')));
  assert.ok(existsSync(join(good.closedRoot, 'closed.txt')));
  const requests = readFileSync(good.requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(requests.map(r => [r.method, r.url]), [
    ['GET', 'https://mcp.commonswarm.com/admin/gate'], ['HEAD', 'https://mcp.commonswarm.com/admin/gate'],
    ['GET', client.client_id], ['GET', client.redirect_uris[0]],
  ]);
  assert.match(readFileSync(good.commands, 'utf8'), /node scripts\/admin-smoke\.mjs --print-client-metadata/);
  for (const [from, to, stop] of [
    ['CLOSED=yes', 'CLOSED=no', 'FAIL site ownership/manifest close not released; STOP'],
    ['OUTCOME=released', 'OUTCOME=rolled-back', 'FAIL site ownership/manifest close not released; STOP'],
    ['PIN_RELEASED=yes', 'PIN_RELEASED=no', 'FAIL site ownership/manifest close not released; STOP'],
    ['MANIFEST_SHA256=', 'WRONG_MANIFEST_SHA256=', 'FAIL site close manifest digest; STOP'],
  ] as const) {
    const bad = fixture();
    writeFileSync(join(bad.site, 'CLOSE.txt'), bad.goodClose.replace(from, to));
    const refused = bad.run();
    assert.equal(refused.signal, null);
    assert.notEqual(refused.status, 0, `${from} accepted`);
    assert.ok(refused.stderr.includes(stop), refused.stderr);
    assert.equal(readFileSync(bad.requests, 'utf8'), '', 'no outside probe after a bad close');
    assert.doesNotMatch(readFileSync(bad.commands, 'utf8'), /\nnode /, 'no metadata command after refusal');
    assert.ok(!existsSync(bad.closedRoot), 'no W5 close receipts after refusal');
    assert.ok(!existsSync(bad.later), 'no later shell side effect after refusal');
  }
});

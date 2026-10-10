/** Cross lane: real live-ordinary-controls receipts through extracted RELEASE.md blocks. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
const temporaryRoot = realpathSync(tmpdir());
const secretParent = mkdtempSync(join(temporaryRoot, 'anvil-secret-root-'));
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFile, writeFile, chmod, mkdir, stat, lstat, mkdtemp, rm } from 'node:fs/promises';
import { ORDINARY_TOOLS } from '../scripts/live-ordinary-controls.mjs';

import { baselineEdgeSha, releaseSha, catalogAt } from './support/live-edge-catalog.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts/live-ordinary-controls.mjs');
const preload = 'data:text/javascript;base64,' + Buffer.from(readFileSync(join(repo, 'tests/support/live-ordinary-controls-transport.mjs'), 'utf8')
  .replace("'https://commonswarm.com'", "'https://yulanventures.com'")).toString('base64');
const planPath = join(repo, 'docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md');
const plan = readFileSync(planPath, 'utf8');
const blocks = [...plan.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]);
const block = id => {
  const matches = blocks.filter(s => s.startsWith(`# step: ${id}\n`));
  assert.equal(matches.length, 1, `one complete ${id} block`);
  return matches[0];
};
const digest = value => createHash('sha256').update(value).digest('hex');
const python = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
assert.ok(python.startsWith('/'), 'absolute Python runtime');
const guardedRm = spawnSync('/bin/sh', ['-c', 'command -v rm'], { encoding: 'utf8' }).stdout.trim();
assert.ok(guardedRm.startsWith('/'), 'absolute installed rm runtime');

const issuer = 'https://mcp.commonswarm.com', api = 'https://api.commonswarm.com';
const client = 'https://yulanventures.com/oauth/c1-controls/client.json';
const redirect = 'https://c1-controls.invalid/callback', resource = `${issuer}/mcp`;
const release = releaseSha, scope = 'openid offline_access mcp';
const baselineTools = (await catalogAt(baselineEdgeSha, ORDINARY_TOOLS)).names;
const releaseTools = (await catalogAt(releaseSha, ORDINARY_TOOLS)).names;
const windowId = 'ABC123', controlsPass = 'pass0001';
const hash = b => createHash('sha256').update(b).digest('hex');
const b64hash = b => createHash('sha256').update(b).digest('base64url');
const uid = '11111111-1111-4111-8111-111111111111', wid = 'c2ea0541-f56d-4c73-bf71-56c5405c4934';
const pid = '33333333-3333-4333-8333-333333333333';
const privateWrite = (p, b) => writeFile(p, typeof b === 'string' ? b : JSON.stringify(b), { mode: 0o600 });
const scriptBytes = readFileSync(script);
const producerSha = digest(scriptBytes);

// --- live-ordinary-controls fixture (same wire contract as tests/live-ordinary-controls.test.mjs) ---
async function liveFixture(t) {
  mkdirSync(secretParent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(secretParent, 'anvil-secret.')); await chmod(root, 0o700);
  const creds = join(root, 'credentials'), human = join(root, 'human'), seat = join(root, 'seat');
  for (const dir of [creds, human, seat]) await mkdir(dir, { mode: 0o700 });
  const clientTimes = new Map();
  const secrets = [], clients = new Set(), families = new Map(), codes = new Map(), access = new Set(), events = [], violations = [];
  const secret = () => { const s = randomBytes(32).toString('base64url'); secrets.push(s); return s; };
  const seatToken = `swm_agt_${secret()}`, anon = secret(); let humanRefresh = secret();
  const clientMetadata = { client_id: client, client_name: 'CommonSwarm C1 ordinary controls', client_uri: 'https://yulanventures.com',
    application_type: 'web', redirect_uris: [redirect], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope };
  const emit = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(body === null ? undefined : JSON.stringify(body));
  };
  const token = (res, f) => {
    const a = secret(), r = secret(); access.add(a); families.set(r, { family: f, consumed: false });
    return emit(res, 200, { token_type: 'Bearer', access_token: a, refresh_token: r, expires_in: 300, scope: 'mcp', ignored_cookie: secret() });
  };
  let signal;
  const f = { consent: undefined, listedTools: baselineTools };
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers['user-agent'], 'curl/8.7.1');
      const url = new URL(req.url, issuer), chunks = [];
      for await (const b of req) chunks.push(b);
      const raw = Buffer.concat(chunks).toString('utf8');
      const p = req.headers['content-type']?.startsWith('application/x-www-form-urlencoded') ? new URLSearchParams(raw) : null;
      const body = raw && !p ? JSON.parse(raw) : null;
      const event = { at: Date.now(), path: url.pathname, method: req.method, grant: p?.get('grant_type'), client: p?.get('client_id'), rpc: body?.method, command: body?.command?.kind }; events.push(event);
      if (url.pathname === '/.well-known/oauth-authorization-server') return emit(res, 200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/reg`,
        code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'offline_access', 'mcp'],
      });
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return emit(res, 200, { resource, authorization_servers: [issuer], scopes_supported: ['mcp'] });
      if (url.pathname === '/oauth/c1-controls/client.json') return emit(res, 200, clientMetadata);
      if (url.pathname === '/reg') {
        assert.equal(req.method, 'POST'); assert.equal(body.token_endpoint_auth_method, 'none');
        const id = randomBytes(24).toString('base64url'); clients.add(id); clientTimes.set(id, event.at);
        return emit(res, 201, { ...body, client_id: id });
      }
      if (url.pathname === '/authorize') {
        res.writeHead(303, { location: `${issuer}/interaction/${randomBytes(12).toString('hex')}`, 'set-cookie': `session=${secret()}; HttpOnly` }); return res.end();
      }
      if (url.pathname === '/token') {
        assert.equal(req.method, 'POST'); assert.equal(p.get('resource'), resource);
        const id = p.get('client_id');
        if (p.get('grant_type') === 'authorization_code') {
          const c = codes.get(p.get('code')); assert.ok(c);
          assert.equal(c.clientId, id); assert.equal(p.get('redirect_uri'), redirect);
          assert.equal(b64hash(p.get('code_verifier')), c.challenge); codes.delete(p.get('code'));
          const family = { clientId: id, revoked: false }; event.family = family;
          if (id !== client) clientTimes.set(id, event.at);
          return token(res, family);
        }
        assert.equal(p.get('grant_type'), 'refresh_token'); const stored = families.get(p.get('refresh_token'));
        if (!stored || stored.family.revoked) { event.rejected = true; event.family = stored?.family; return emit(res, 400, { error: 'invalid_grant' }); }
        assert.equal(stored.family.clientId, id); event.family = stored.family;
        if (stored.consumed) { stored.family.revoked = true; event.rejected = true; return emit(res, 400, { error: 'invalid_grant' }); }
        stored.consumed = true; return token(res, stored.family);
      }
      if (url.pathname === '/revoke') {
        const stored = families.get(p.get('token')); assert.ok(stored); stored.family.revoked = true;
        return emit(res, 204, null);
      }
      if (url.pathname === '/mcp') {
        assert.ok(access.has(req.headers.authorization?.slice(7))); assert.equal(body.jsonrpc, '2.0');
        if (body.method === 'notifications/initialized') return emit(res, 202, null);
        let result;
        if (body.method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'commonswarm' } };
        else if (body.method === 'tools/call') {
          assert.equal(req.headers['mcp-protocol-version'], '2025-06-18');
          assert.equal(body.params.name, 'claim_seat');
          assert.deepEqual(body.params.arguments, { workspace_id: wid, name: `c1-controls-runner-${release.slice(0, 8)}-${controlsPass}`,
            request_id: `c1_controls_claim_${hash(`${release}:${wid}:c1-controls-runner-${release.slice(0, 8)}-${controlsPass}`).slice(0, 40)}` });
          result = { content: [{ type: 'text', text: JSON.stringify({ workspace_id: wid, name: `c1-controls-runner-${release.slice(0, 8)}-${controlsPass}`,
            seat_id: '44444444-4444-4444-8444-444444444444', handle: 'seat_' + 'a'.repeat(32) }) }] };
        } else {
          assert.equal(body.method, 'tools/list');
          result = { tools: f.listedTools.map(name => ({ name })) };
        }
        return emit(res, 200, { jsonrpc: '2.0', id: body.id, result });
      }
      if (url.pathname === '/auth/v1/token') {
        assert.equal(url.searchParams.get('grant_type'), 'refresh_token');
        assert.equal(body.refresh_token, humanRefresh); assert.equal(req.headers.apikey, anon);
        const now = new Date().toISOString(); humanRefresh = secret();
        const humanAccess = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
          Buffer.from(JSON.stringify({ sub: uid, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), secret()].join('.');
        secrets.push(humanAccess);
        return emit(res, 200, { access_token: humanAccess, refresh_token: humanRefresh, token_type: 'bearer', expires_in: 3600,
          user: { id: uid, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: now } });
      }
      if (url.pathname === '/rest/v1/workspaces') {
        return emit(res, 200, [{ workspace_id: wid, name: 'Cold Agent Test 0.1.12' }]);
      }
      if (url.pathname === '/functions/v1/read') {
        if (body.resource === 'members') return emit(res, 200, { members: [], agents: [], identity: {
          credential_valid: true, workspace_id: wid, principal_id: pid, owner_user_id: uid, workspace_name: 'Cold Agent Test 0.1.12',
        } });
        return emit(res, 200, { signals: signal ? [signal] : [] });
      }
      if (url.pathname === '/functions/v1/command') {
        signal = { id: randomUUID(), workspace_id: wid, from: pid, from_kind: 'agent', to: null, to_agent: null, in_reply_to: null, about: null,
          kind: 'note', body: body.command.body, until: new Date(Date.now() + 60000).toISOString(), created_at: new Date().toISOString() };
        return emit(res, 200, { status: 'accepted', ok: true, event_ids: [], signal });
      }
      throw new Error('unexpected wire request');
    } catch { violations.push({ path: req.url.split('?')[0], reason: 'wire contract failure' }); emit(res, 500, { error: 'fixture_contract_violation' }); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(r => server.close(r));
    assert.deepEqual(violations, []);
    assert.ok(root.startsWith(`${secretParent}${sep}`), 'cleanup is inside the test-owned mkdtemp root');
    assert.equal(realpathSync(root), root);
    await rm(root, { recursive: true });
  });
  const profileId = hash(api).slice(0, 24);
  await privateWrite(join(human, 'target.json'), { url: api, anon_key: anon });
  await privateWrite(join(human, `${profileId}.json`), { version: 1, refreshToken: humanRefresh, generation: 0, deviceId: randomUUID(), userId: uid });
  await privateWrite(join(human, `${profileId}.profile.json`), { version: 1, userId: uid, workspaceId: wid, pendingCommands: {} });
  await privateWrite(join(seat, 'profile.json'), { version: 1, url: api, anon_key: anon, workspace_id: wid, principal_id: pid, credential_file: join(seat, 'credential.json') });
  await privateWrite(join(seat, 'credential.json'), { message: 'Agent credential minted. It is bound to this run, so the agent\'s work is attributable to it.',
    status: 'accepted', principal_id: pid, token_id: randomUUID(), run_id: randomUUID(), agent_token: seatToken });
  let sequence = 0;
  async function run(command, extra = [], { handoff = true, outName } = {}) {
    const pointer = join(root, `pointers${sequence++}`); await mkdir(pointer, { mode: 0o700 });
    const out = outName ?? join(root, `receipt${sequence}.json`);
    const args = command === 'consent' ? ['consent', '--phase', 'pre-W1', '--pointer-dir', pointer] :
      command === 'final-cleanup' ? ['final-cleanup', '--consent-receipt', f.consent] :
        command === 'probe-credentials' ? ['probe-credentials', '--window', 'W2', '--window-id', windowId, '--consent-receipt', f.consent, '--human-profile', human] :
        ['window', '--phase', 'before', '--window', 'W1', '--window-id', windowId, '--consent-receipt', f.consent, '--human-profile', human, '--seat-profile', seat];
    if (command === 'window') args.push('--controls-pass', controlsPass);
    if (command !== 'final-cleanup') {
      const phase = extra[extra.indexOf('--phase') + 1], window = extra[extra.indexOf('--window') + 1];
      const switched = phase === 'post-W5' || ['W5', 'W6', 'W7'].includes(window) || (window === 'W4' && phase === 'after');
      args.push('--live-edge-sha', switched ? release : baselineEdgeSha);
    }
    for (let i = 0; i < extra.length; i++) {
      const arg = extra[i]; const n = args.indexOf(arg);
      if (n >= 0) args.splice(n, 2);
      args.push(arg); if (arg !== '--dry-run') args.push(extra[++i]);
    }
    const child = spawn(process.execPath, ['--import', preload, script, ...args, ...(command === 'final-cleanup' ? [] : ['--workspace-id', wid]), '--release-sha', release, '--cred-dir', creds, '--out', out,
      '--request-timeout-ms', '1000', '--consent-timeout-ms', '2000', '--total-timeout-ms', '12000'], {
      cwd: repo, env: { ...process.env, LIVE_CONTROLS_FIXTURE_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', done = false, handoffError;
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const completed = new Promise((r, j) => { child.once('error', j); child.once('exit', code => { done = true; r(code); }); });
    const handoffs = (async () => {
      if (command !== 'consent' || !handoff) return;
      for (const name of ['cimd', 'dcr']) {
        const path = join(pointer, `${name}-authorize-url.txt`); let a;
        while (!done) {
          try {
            const text = (await readFile(path, 'utf8')).trim();
            if (!text) { await sleep(10); continue; }
            a = new URL(text); break;
          } catch (e) { if (e.code !== 'ENOENT') throw e; await sleep(10); }
        }
        if (!a) break;
        const code = secret(); codes.set(code, { clientId: a.searchParams.get('client_id'), challenge: a.searchParams.get('code_challenge') });
        const cb = new URL(redirect); cb.search = new URLSearchParams({ code, state: a.searchParams.get('state'), iss: issuer });
        await writeFile(join(pointer, `${name}-callback-url.txt`), cb.href, { mode: 0o600 });
      }
    })().catch(e => { handoffError = e; child.kill(); });
    const exit = await completed; await handoffs; if (handoffError) throw handoffError;
    let receipt, bytes;
    try { bytes = await readFile(out); receipt = JSON.parse(bytes); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { exit, output, receipt, bytes, out };
  }
  f.run = run;
  f.events = events;
  return f;
}

async function produceReceipts(t) {
  const f = await liveFixture(t);
  const pre = await f.run('consent'); assert.equal(pre.exit, 0, pre.output); f.consent = pre.out;
  const w1 = await f.run('window', ['--window', 'W1', '--phase', 'before']);
  assert.equal(w1.exit, 0, w1.output);
  const w2 = await f.run('window', ['--window', 'W2', '--phase', 'before']);
  assert.equal(w2.exit, 0, w2.output);
  const w2b = await f.run('window', ['--window', 'W2b', '--phase', 'before']);
  assert.equal(w2b.exit, 0, w2b.output);
  for (const window of ['W3', 'W4', 'W5']) {
    if (window === 'W5') f.listedTools = releaseTools;
    const w = await f.run('window', ['--window', window]);
    assert.equal(w.exit, 0, w.output);
  }
  const post = await f.run('consent', ['--phase', 'post-W5', '--prior-consent', pre.out]);
  assert.equal(post.exit, 0, post.output); f.consent = post.out;
  const w5after = await f.run('window', ['--window', 'W5', '--phase', 'after']);
  assert.equal(w5after.exit, 0, w5after.output);
  assert.equal(pre.receipt.producer_sha256, producerSha);
  assert.equal(w2.receipt.producer_sha256, producerSha);
  assert.equal(post.receipt.producer_sha256, producerSha);
  assert.equal(w5after.receipt.producer_sha256, producerSha);
  return {
    preW1: { bytes: pre.bytes, path: pre.out },
    w1Before: { bytes: w1.bytes, path: w1.out },
    w2Before: { bytes: w2.bytes, path: w2.out },
    w2bBefore: { bytes: w2b.bytes, path: w2b.out },
    postW5: { bytes: post.bytes, path: post.out },
    w5After: { bytes: w5after.bytes, path: w5after.out },
  };
}

// --- plan block fixture (stubs as tests/admin-release-live-failclosed-w123.test.ts) ---
const dispatcher = String.raw`
import builtins,hashlib,io,json,os,pathlib,random,shlex,shutil,string,subprocess,sys,urllib.error,urllib.parse,urllib.request
root=pathlib.Path(os.environ['FIXTURE_ROOT']); cfg=json.loads((root/'commands.json').read_text())
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
with (root/'argv.jsonl').open('a') as log: log.write(json.dumps([name]+args)+'\n')
def refuse(): raise SystemExit('UNMODELLED '+name+' '+repr(args))
def owned(value):
    p=pathlib.Path(value)
    if not p.is_absolute() or not str(p).startswith(str(root)+'/'): refuse()
    return p
def output(value): print(value)
if name=='python3':
    if args==['-'] or (args and args[0]=='-'):
        source=sys.stdin.read(); sys.argv=['-']+args[1:]
    elif len(args)>=2 and args[0]=='-c': source=args[1]; sys.argv=['-c']+args[2:]
    else: refuse()
    import socket
    def no_network(*a,**kw): raise RuntimeError('UNMODELLED network')
    socket.socket.connect=no_network; socket.create_connection=no_network
    if cfg.get('probe'):
        class Response(io.BytesIO):
            status=200
            def __init__(self,body): super().__init__(json.dumps(body).encode())
        class Issuer:
            def open(self,req,timeout):
                if timeout!=15 or req.get_header('User-agent')!='curl/8.7.1': refuse()
                statepath=root/'probe-state.json'; state=json.loads(statepath.read_text())
                url=req.full_url; issuer='https://mcp.commonswarm.com'
                state['calls'].append(url)
                with statepath.open('w') as f: json.dump(state,f)
                if url==issuer+'/health': return Response({'ok':True})
                if url==issuer+'/.well-known/oauth-authorization-server':
                    return Response({'issuer':issuer,'token_endpoint':issuer+'/token'})  # like the live issuer: no revocation_endpoint
                if url==issuer+'/.well-known/oauth-protected-resource/mcp': return Response({'resource':issuer+'/mcp'})
                if url==issuer+'/token':
                    form=dict(urllib.parse.parse_qsl(req.data.decode()))
                    if req.get_method()!='POST' or form!={'grant_type':'refresh_token','client_id':state['client'],
                        'refresh_token':state['current'],'resource':issuer+'/mcp'}: refuse()
                    if cfg.get('refresh_status')==400:
                        raise urllib.error.HTTPError(url,400,'fixture rejection',{},io.BytesIO(b'{"error":"invalid_grant"}'))
                    state['current']=state['rotated']
                    with statepath.open('w') as f: json.dump(state,f)
                    return Response({'token_type':'Bearer','access_token':state['access'],'refresh_token':state['rotated']})
                body=json.loads(req.data)
                if url==issuer+'/mcp':
                    if req.get_method()!='POST' or req.get_header('Authorization')!='Bearer '+state['access'] or body.get('method')!='initialize': refuse()
                    stored=pathlib.Path(os.environ['SECRET_STAGE'])/'ordinary-probes.json'
                    state['persisted_before_initialize']=json.loads(stored.read_text())['mcp_refresh_token']==state['rotated']
                    state['initialize_file_mode']=stored.stat().st_mode & 0o777
                    state['initialize_saw_replacement']=stored.stat().st_ino!=state['original_inode']
                    with statepath.open('w') as f: json.dump(state,f)
                    return Response({'jsonrpc':'2.0','id':body['id'],'result':{'serverInfo':{'name':'fixture'}}})
                if url=='https://api.commonswarm.com/functions/v1/read':
                    if req.get_method()!='POST' or req.get_header('Authorization')!='Bearer '+state['human'] or body!={'resource':'pending_access','workspace_id':state['workspace']}: refuse()
                    return Response({'pending':[]})
                refuse()
        urllib.request.build_opener=lambda *a: Issuer()
    exec(compile(source,'<complete-plan-block>','exec'))
elif name=='ai_deadline' and cfg.get('probe'):
    if args: refuse()
elif name=='ssh' and cfg.get('probe'):
    if len(args)!=6 or args[:5]!=['-o','BatchMode=yes','-o','ConnectTimeout=10','ops@100.115.66.74']: refuse()
    remote=shlex.split(args[5])
    if len(remote)!=7 or remote[:4]!=['sudo','-n','/bin/bash','-c']: refuse()
    # Execute the extracted remote shell, including its real mode/digest checks.
    result=subprocess.run(['/bin/bash','-c']+remote[4:],input=sys.stdin.buffer.read())
    raise SystemExit(result.returncode)
elif name=='install' and cfg.get('probe') and len(args)==8 and args[:7]==['-o','root','-g','root','-m','600','/dev/stdin']:
    target=owned(args[7])
    with target.open('xb') as f: f.write(sys.stdin.buffer.read())
    target.chmod(0o600)
elif name=='rm' and cfg.get('probe'):
    if len(args)!=2 or args[0]!='--' or owned(args[1])!=root/'c1-run'/('probe-credentials-W2-'+cfg['window_id']+'.json'): refuse()
    # Delegate to the installed guard on the Mac; do not bypass it in a test shim.
    raise SystemExit(subprocess.run([cfg['guarded_rm']]+args).returncode)
elif name=='cut' and cfg.get('probe'):
    if args!=['-d',' ','-f','1']: refuse()
    for line in sys.stdin: output(line.split(' ')[0])
elif name in ('ai_deadline','ai_ro','ai_db','openssl','nice','timeout','docker','node'): refuse()
elif name=='chmod':
    if len(args)<2 or args[0] not in ('0600','0700'): refuse()
    for value in args[1:]: owned(value).chmod(int(args[0],8))
elif name=='install' and len(args)==4 and args[:2]==['-m','0600']:
    target=owned(args[3]); shutil.copyfile(owned(args[2]),target); target.chmod(0o600)
elif name=='stat' and len(args)==3 and args[:2]==['-c','%a']:
    output(format(owned(args[2]).stat().st_mode & 0o777,'o'))
elif name=='sha256sum':
    if len(args)!=1: refuse()
    output(hashlib.sha256(owned(args[0]).read_bytes()).hexdigest()+'  '+args[0])
elif name=='awk':
    if args!=['{print $1}']: refuse()
    for line in sys.stdin: output(line.split()[0])
elif name=='mktemp':
    if len(args)!=2 or args[0]!='-d' or not args[1].endswith('.XXXXXX'): refuse()
    created=owned(args[1][:-6]+''.join(random.choice(string.ascii_letters+string.digits) for _ in range(6)))
    created.mkdir(mode=0o700); output(created)
elif name=='mkdir':
    if len(args)!=2 or args[0]!='-p': refuse()
    owned(args[1]).mkdir(parents=True,exist_ok=True)
elif name=='cp' and len(args)==2:
    shutil.copyfile(owned(args[0]),owned(args[1]))
elif name=='date':
    if args!=['-u','+%Y-%m-%dT%H:%M:%SZ']: refuse()
    output('2026-10-03T12:00:00Z')
elif name=='cat':
    if len(args)!=1: refuse()
    sys.stdout.write(owned(args[0]).read_text())
else: refuse()
`;

const scratch = mkdtempSync(join(temporaryRoot, 'c1-cross-plan-'));
const planScratch = join(scratch, 'receipts');
mkdirSync(planScratch, { recursive: true, mode: 0o700 });

function planFixture(config = {}) {
  const root = mkdtempSync(join(scratch, 'case-'));
  const bin = join(root, 'bin'), proof = join(root, 'proof');
  const stage = config.probe ? join(root, 'tmp/anvil-secret.ABC123') : join(root, 'stage');
  for (const dir of [bin, proof, join(root, 'etc/commonswarm-oauth'), join(root, 'admin-issuance/release-proofs'), join(root, 'archive'), join(root, 'release/scripts'), join(root, 'tmp'), join(root, 'caddy'), stage, join(root, 'c1-run')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const put = (path, value) => writeFileSync(join(root, path), Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  put('commands.json', { sha: release, guarded_rm: guardedRm, window_id: windowId, ...config });
  put('argv.jsonl', '');
  put('release/scripts/live-ordinary-controls.mjs', config.producerBytes ?? scriptBytes);
  for (const name of ['python3', 'chmod', 'install', 'stat', 'sha256sum', 'awk', 'mktemp', 'mkdir', 'cp', 'date', 'cat', ...(config.probe ? ['ssh', 'rm', 'cut', 'ai_deadline'] : [])]) {
    writeFileSync(join(bin, name), '#!' + python + '\n' + dispatcher, { mode: 0o700 });
  }
  const releaseRoot = join(root, 'admin-issuance/releases', release);
  mkdirSync(join(releaseRoot, 'scripts'), { recursive: true, mode: 0o700 });
  put(`admin-issuance/releases/${release}/scripts/live-ordinary-controls.mjs`, config.producerBytes ?? scriptBytes);
  put(`admin-issuance/releases/${release}/RELEASE_SHA`, `${release}\n`);
  put('home.env', 'EDGE=fixture\n');
  put('etc/commonswarm-oauth/compose.env', 'MCP_OAUTH_IMAGE=fixture\n');
  put('etc/commonswarm-oauth/service.env', 'MCP_OAUTH_ENABLED=1\n');
  for (const name of ['20-commonswarm-mcp.caddy', '10-commonswarm-api.caddy']) put(`caddy/${name}`, `fixture ${name}\n`);
  const env = {
    ...process.env, PATH: bin, FIXTURE_ROOT: root, RELEASE_SHA: release, RELEASE_ROOT: releaseRoot,
    PROOF_DIR: proof, SECRET_STAGE: stage, PSQL_IMAGE: 'fixture-postgres',
  };
  function remap(source) {
    assert.ok(root.startsWith(`${scratch}${sep}`), 'plan fixture is inside the test-owned tmpdir root');
    // Discover host paths from the plan so Ubuntu needs no Mac path literals.
    if (config.probe) {
      const stageSource = block('ai-w2-stage-probes');
      const guardPath = stageSource.match(/command -v rm\)" = (\/\S+)/)?.[1];
      const producerDir = stageSource.match(/^PROBE_CREDENTIALS_FILE=(\/.*)\/probe-credentials-W2-/m)?.[1];
      assert.ok(guardPath && producerDir, 'stage block declares guard and producer paths');
      source = source.split(guardPath).join(join(bin, 'rm')).split(producerDir).join(join(root, 'c1-run'));
    }
    for (const [from, to] of [
      ['/tmp/admin-issuance-', join(root, 'archive/admin-issuance-')],
      ['/home/commonswarm/admin-issuance', join(root, 'admin-issuance')],
      ['/home/commonswarm/.env', join(root, 'home.env')],
      ['/etc/commonswarm-oauth', join(root, 'etc/commonswarm-oauth')],
      ['/etc/caddy/sites', join(root, 'caddy')],
    ]) {
      assert.ok(to.startsWith(`${root}${sep}`), 'plan path maps inside the test-owned mkdtemp root');
      source = source.split(from).join(to);
    }
    return source.replace(/\/(?:private\/)?tmp\/anvil-secret/g, join(root, 'tmp/anvil-secret'));
  }
  function run(steps, window, extra = {}) {
    const source = remap(steps.map(block).join('\n'));
    const runEnv = { ...env, WINDOW: window, WINDOW_ID: windowId, ...extra };
    const result = spawnSync('/bin/bash', [], { input: source, env: runEnv, encoding: 'utf8', timeout: 15_000 });
    assert.ifError(result.error); assert.equal(result.signal, null);
    assert.doesNotMatch(result.stdout + result.stderr, /UNMODELLED/);
    return result;
  }
  return { root, proof, stage, put, run, releaseRoot };
}

function stageReceipt(f, name, bytes) {
  const path = join(f.root, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

function buildArchive(f, planText, producerBytes = scriptBytes) {
  const releaseRoot = join(f.root, 'admin-issuance/releases', release);
  const scriptPath = join(releaseRoot, 'scripts/live-ordinary-controls.mjs');
  const planRel = 'docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md';
  const planPathOnDisk = join(releaseRoot, planRel);
  mkdirSync(dirname(planPathOnDisk), { recursive: true, mode: 0o700 });
  writeFileSync(scriptPath, producerBytes, { mode: 0o600 });
  writeFileSync(planPathOnDisk, planText, { mode: 0o600 });
  const archive = join(f.root, 'archive', `admin-issuance-${release}-${windowId}.tar`);
  const made = spawnSync(python, ['-c',
    'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t:\n    [t.add(sys.argv[i+1],arcname=sys.argv[i]) for i in range(2,len(sys.argv),2)]',
    archive, 'scripts/live-ordinary-controls.mjs', scriptPath, planRel, planPathOnDisk], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  chmodSync(archive, 0o600);
  return { archive, archiveSha: digest(readFileSync(archive)) };
}

function openRun(f, window, consentBytes, liveBytes, { producerBytes = scriptBytes, planText = 'fixture plan\n' } = {}) {
  const consentPath = stageReceipt(f, 'open-consent.json', consentBytes);
  const livePath = stageReceipt(f, 'open-live.json', liveBytes);
  const live = JSON.parse(liveBytes.toString());
  const { archive, archiveSha } = buildArchive(f, planText, producerBytes);
  f.put('open-inputs.json', { release_sha: release, baseline_edge_sha: baselineEdgeSha, window_id: live.window_id, window, archive_sha256: archiveSha, plan_sha256: digest(planText) });
  f.put('gates.json', '{}');
  for (const name of ['20-commonswarm-mcp.caddy', '10-commonswarm-api.caddy']) f.put('caddy/' + name, 'fixture ' + name);
  return f.run(['ai-open'], window, {
    INPUTS_FILE: join(f.root, 'open-inputs.json'),
    GATE_RECEIPT_FILE: join(f.root, 'gates.json'),
    PLAN_FILE: join(f.root, 'unused-plan'),
    LIVE_CONTROLS_FILE: livePath,
    CONSENT_RECEIPT_FILE: consentPath,
    BOX_ARCHIVE_PATH: archive,
    PROOF_DIR: join(f.root, 'admin-issuance/release-proofs', `${release}-${window}-${windowId}`),
  });
}

function liveControlsRun(f, window, phase, consentBytes, liveBytes) {
  const consentPath = stageReceipt(f, 'live-consent.json', consentBytes);
  const livePath = stageReceipt(f, 'live-controls.json', liveBytes);
  const live = JSON.parse(liveBytes.toString());
  assert.equal(digest(readFileSync(join(f.releaseRoot, 'scripts/live-ordinary-controls.mjs'))), live.producer_sha256);
  const { archive, archiveSha } = buildArchive(f, 'fixture plan\n');
  f.put('inputs.json', { release_sha: release, baseline_edge_sha: ['W5','W6','W7'].includes(live.window) ? release : baselineEdgeSha, window_id: live.window_id, window: live.window, archive_sha256: archiveSha });
  return f.run(['ai-live-controls'], window, {
    INPUTS_FILE: join(f.root, 'inputs.json'),
    LIVE_CONTROLS_FILE: livePath,
    CONSENT_RECEIPT_FILE: consentPath,
    RELEASE_ROOT: f.releaseRoot,
    BOX_ARCHIVE_PATH: archive,
    PROOF_DIR: f.proof,
    WINDOW: window,
    WINDOW_ID: windowId,
    PHASE: phase,
  });
}

function pass(result, line) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout + result.stderr, new RegExp(line));
}

function stopped(result, text) {
  assert.notEqual(result.status, 0, 'expected refusal');
  assert.ok((result.stdout + result.stderr).includes(text), `expected ${text}; got ${JSON.stringify(result.stderr)}`);
}

/** @type {Awaited<ReturnType<typeof produceReceipts>> | undefined} */
let produced;

test('cross-live-controls / script-produces-binding-receipts', async t => {
  produced = await produceReceipts(t);
  for (const [name, file] of Object.entries(produced)) {
    const dest = join(planScratch, `${name}.json`);
    writeFileSync(dest, file.bytes, { mode: 0o600 });
    file.stored = dest;
  }
  assert.equal(produced.preW1.bytes.toString(), readFileSync(produced.preW1.stored, 'utf8'));
});

test('cross-live-controls / ai-open W1 before passes with real producer and receipts', () => {
  const f = planFixture();
  const proofDir = join(f.root, 'admin-issuance/release-proofs', `${release}-W1-${windowId}`);
  const result = openRun(f, 'W1', produced.preW1.bytes, produced.w1Before.bytes);
  pass(result, /PASS ai-open/);
  assert.equal(readFileSync(join(proofDir, 'consent-pre-W1.json'), 'utf8'), produced.preW1.bytes.toString());
});

test('cross-live-controls / ai-live-controls W2 before passes with real producer and receipts', () => {
  const f = planFixture();
  const result = liveControlsRun(f, 'W2', 'before', produced.preW1.bytes, produced.w2Before.bytes);
  pass(result, /PASS live authenticated ordinary controls bound to consent pre-W1 and released producer/);
  const ordinary = readFileSync(join(f.proof, 'ordinary-before.json'), 'utf8');
  assert.deepEqual(JSON.parse(ordinary), JSON.parse(produced.w2Before.bytes.toString()));
});

test('cross-live-controls / W2b before: ai-open and ai-live-controls pass with the real producer bound to the pre-W1 consent', () => {
  assert.equal(JSON.parse(produced.w2bBefore.bytes.toString()).window, 'W2b');
  assert.equal(JSON.parse(produced.w2bBefore.bytes.toString()).producer_sha256, producerSha);
  const opened = planFixture();
  const proofDir = join(opened.root, 'admin-issuance/release-proofs', `${release}-W2b-${windowId}`);
  pass(openRun(opened, 'W2b', produced.preW1.bytes, produced.w2bBefore.bytes), /PASS ai-open/);
  assert.equal(readFileSync(join(proofDir, 'consent-pre-W1.json'), 'utf8'), produced.preW1.bytes.toString());
  const f = planFixture();
  pass(liveControlsRun(f, 'W2b', 'before', produced.preW1.bytes, produced.w2bBefore.bytes), /PASS live authenticated ordinary controls bound to consent pre-W1 and released producer/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.proof, 'ordinary-before.json'), 'utf8')), JSON.parse(produced.w2bBefore.bytes.toString()));
});

test('cross-live-controls / negative post-W5 consent at W2b refuses ai-live-controls', () => {
  const f = planFixture();
  const live = JSON.parse(produced.w2bBefore.bytes.toString());
  live.consent_receipt_sha256 = digest(produced.postW5.bytes);
  stopped(liveControlsRun(f, 'W2b', 'before', produced.postW5.bytes, Buffer.from(JSON.stringify(live, null, 2) + '\n')),
    'FAIL ai-live-controls: consent_phase for W2b before expected pre-W1 got post-W5; STOP');
});

test('cross-live-controls / ai-live-controls W5 after passes with real producer and receipts', () => {
  const f = planFixture();
  const result = liveControlsRun(f, 'W5', 'after', produced.postW5.bytes, produced.w5After.bytes);
  pass(result, /PASS live authenticated ordinary controls bound to consent post-W5 and released producer/);
  assert.ok(existsSync(join(f.proof, 'ordinary-after.json')));
  assert.equal(readFileSync(join(f.proof, 'consent-post-W5.json'), 'utf8'), produced.postW5.bytes.toString());
});

test('cross-live-controls / negative false-control refuses ai-live-controls', () => {
  const f = planFixture();
  const live = JSON.parse(produced.w2Before.bytes.toString());
  live.controls.hosted_mcp_consent_refresh = false;
  const tampered = Buffer.from(JSON.stringify(live, null, 2) + '\n');
  stopped(liveControlsRun(f, 'W2', 'before', produced.preW1.bytes, tampered),
    'FAIL ai-live-controls: live control hosted_mcp_consent_refresh expected true got false; STOP');
});

test('cross-live-controls / negative consent-byte mismatch refuses ai-open', () => {
  const f = planFixture();
  const consent = JSON.parse(produced.preW1.bytes.toString());
  consent.dcr_client_ids[0] = consent.dcr_client_ids[0].slice(0, -1) + (consent.dcr_client_ids[0].at(-1) === 'a' ? 'b' : 'a');
  stopped(openRun(f, 'W1', Buffer.from(JSON.stringify(consent, null, 2) + '\n'), produced.w1Before.bytes),
    'FAIL ai-open: live consent_receipt_sha256 expected sha256-of-CONSENT_RECEIPT_FILE got mismatch; STOP');
});

test('cross-live-controls / negative archive producer mismatch refuses ai-open', () => {
  const f = planFixture();
  stopped(openRun(f, 'W1', produced.preW1.bytes, produced.w1Before.bytes, { producerBytes: Buffer.concat([scriptBytes, Buffer.from('\n')]) }),
    'FAIL ai-open: live producer_sha256 expected sha256-of-released-script got mismatch; STOP');
});

test('cross-live-controls / negative post-W5 consent at W2 refuses ai-live-controls', () => {
  const f = planFixture();
  const live = JSON.parse(produced.w2Before.bytes.toString());
  live.consent_receipt_sha256 = digest(produced.postW5.bytes);
  stopped(liveControlsRun(f, 'W2', 'before', produced.postW5.bytes, Buffer.from(JSON.stringify(live, null, 2) + '\n')),
    'FAIL ai-live-controls: consent_phase for W2 before expected pre-W1 got post-W5; STOP');
});

// Cross the secret handoff boundary with actual producer bytes, not hand-built credentials.
function probeFixture(t, config = {}) {
  const f = planFixture({ probe: true, ...config });
  t.after(() => {
    assert.ok(f.root.startsWith(`${scratch}${sep}`), 'cleanup stays inside the test-owned tmpdir');
    assert.equal(realpathSync(f.root), f.root);
    const result = spawnSync(guardedRm, ['-rf', f.root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(f.root), 'probe fixture removed through the installed rm');
  });
  return f;
}

function probeInputs(f) {
  const end = Math.floor(Date.now() / 1000) + 600;
  f.put('probe-inputs.json', { release_sha: release, window: 'W2', window_id: windowId,
    probe_workspace_id: wid, window_end_utc: new Date(end * 1000).toISOString().replace('.000Z', 'Z') });
  const proof = join(f.root, 'admin-issuance/release-proofs', `${release}-W2-${windowId}`);
  mkdirSync(proof, { recursive: true, mode: 0o700 });
  writeFileSync(join(proof, 'secret-stage.path'), f.stage + '\n', { mode: 0o600 });
  return { INPUTS_FILE: join(f.root, 'probe-inputs.json') };
}

const probeLocal = f => join(f.root, 'c1-run', `probe-credentials-W2-${windowId}.json`);
const commandCalls = f => readFileSync(join(f.root, 'argv.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const probeState = f => JSON.parse(readFileSync(join(f.root, 'probe-state.json'), 'utf8'));
function prepareIssuer(f, credentials) {
  f.put('probe-state.json', { calls: [], current: credentials.mcp_refresh_token, client: credentials.mcp_client_id,
    human: credentials.human_access_token, workspace: credentials.workspace_id,
    rotated: randomBytes(32).toString('base64url'), access: randomBytes(32).toString('base64url'),
    original_inode: lstatSync(join(f.stage, 'ordinary-probes.json')).ino });
}
function noProbeSecrets(f, credentials, result) {
  const visible = result.stdout + result.stderr + readFileSync(join(f.root, 'argv.jsonl'), 'utf8');
  const secrets = [credentials.mcp_refresh_token, credentials.human_access_token];
  if (existsSync(join(f.root, 'probe-state.json'))) {
    const state = probeState(f); secrets.push(state.rotated, state.access);
  }
  for (const secret of secrets) assert.ok(!visible.includes(secret), 'probe secrets stay out of argv and output');
}

test('cross-live-controls / real probe-credentials through W2 stage and between-probes', async t => {
  const f = probeFixture(t);
  const live = await liveFixture(t);
  const consent = await live.run('consent'); assert.equal(consent.exit, 0, consent.output); live.consent = consent.out;
  const before = live.events.length;
  // The producer writes the very path the extracted stage block will consume.
  const produced = await live.run('probe-credentials', [], { outName: probeLocal(f) });
  assert.equal(produced.exit, 0, produced.output);
  assert.equal(produced.output, 'PASS probe-credentials written; DCR grant handed off to W2-probes\n');
  assert.equal(lstatSync(produced.out).mode & 0o777, 0o600);
  assert.equal(produced.receipt.mcp_client_id, consent.receipt.dcr_client_ids[0]);
  const producerCalls = live.events.slice(before);
  assert.equal(producerCalls.filter(e => e.path === '/auth/v1/token').length, 1, 'producer refreshes the human store once');
  assert.equal(producerCalls.filter(e => e.grant === 'refresh_token').length, 0, 'producer does not consume the handed-off MCP refresh token');

  await t.test('positive: exact upload, absence proof and durable rotation before initialize', () => {
    const stage = f.run(['ai-w2-stage-probes'], 'W2', probeInputs(f));
    pass(stage, /PASS ai-w2-stage-probes: box ordinary-probes.json 0600 with matching digest; local copy removed/);
    const staged = join(f.stage, 'ordinary-probes.json');
    assert.equal(lstatSync(staged).mode & 0o777, 0o600);
    assert.equal(digest(readFileSync(staged)), digest(produced.bytes), 'the real producer bytes reach SECRET_STAGE unchanged');
    assert.throws(() => lstatSync(produced.out), { code: 'ENOENT' }, 'local copy is absent, including symlinks');
    const calls = commandCalls(f);
    assert.equal(calls.filter(c => c[0] === 'ssh').length, 1, 'one stdin upload');
    assert.deepEqual(calls.filter(c => c[0] === 'rm'), [['rm', '--', produced.out]], 'guarded deletion targets the producer output');
    noProbeSecrets(f, produced.receipt, stage);

    prepareIssuer(f, produced.receipt);
    const between = f.run(['ai-w2-between-probes'], 'W2', { VERSION: '20261003000001' });
    assert.equal(between.status, 0, between.stderr);
    const state = probeState(f);
    assert.deepEqual(state.calls, [issuer + '/health', issuer + '/.well-known/oauth-authorization-server',
      issuer + '/.well-known/oauth-protected-resource/mcp', issuer + '/token', resource, api + '/functions/v1/read']);
    assert.equal(state.calls.filter(url => url === issuer + '/token').length, 1, 'between-probes refreshes exactly once');
    assert.equal(state.persisted_before_initialize, true, 'initialize sees the rotated token on disk');
    assert.equal(state.initialize_saw_replacement, true, 'rotation replaces the original file atomically');
    assert.equal(state.initialize_file_mode, 0o600);
    const retained = JSON.parse(readFileSync(staged, 'utf8'));
    assert.ok(retained.mcp_refresh_token === state.rotated && retained.mcp_refresh_token !== produced.receipt.mcp_refresh_token,
      'the new refresh token is retained');
    delete retained.mcp_refresh_token;
    const original = { ...produced.receipt }; delete original.mcp_refresh_token;
    assert.ok(isDeepStrictEqual(retained, original), 'rotation preserves the other producer fields');
    assert.deepEqual(readdirSync(f.stage), ['ordinary-probes.json'], 'no temporary rotation file remains');
    const proof = readFileSync(join(f.proof, 'between-20261003000001.json'), 'utf8');
    const receipt = JSON.parse(proof);
    assert.equal(receipt.release_sha, release); assert.equal(receipt.version, '20261003000001');
    for (const key of ['discovery', 'rotation', 'refreshed', 'token_health', 'human_read']) assert.equal(receipt[key], true, key);
    noProbeSecrets(f, produced.receipt, { ...between, stdout: between.stdout + proof });
  });

  for (const [name, mutate, refusal] of [
    ['one key removed', c => { delete c.mcp_resource; }, 'probe credentials keys expected probe-contract-keys got other-set'],
    ['wrong window_id', c => { c.window_id = 'XYZ789'; }, 'probe credentials window_id expected input-window-id got mismatch'],
    ['human expiry below window end plus 300', (c, inputs) => {
      c.human_token_exp = Math.floor(Date.parse(inputs.window_end_utc) / 1000) + 299;
    }, 'human_token_exp expected window_end_utc-plus-300s got shorter'],
  ]) await t.test(`negative: ${name}`, child => {
    const bad = probeFixture(child);
    const env = probeInputs(bad), credentials = JSON.parse(produced.bytes.toString());
    mutate(credentials, JSON.parse(readFileSync(env.INPUTS_FILE, 'utf8')));
    writeFileSync(probeLocal(bad), JSON.stringify(credentials), { mode: 0o600 });
    const result = bad.run(['ai-w2-stage-probes'], 'W2', env);
    stopped(result, `FAIL ai-w2-stage-probes: ${refusal}; STOP before any W2 write`);
    const calls = commandCalls(bad);
    assert.equal(calls.filter(c => ['ssh', 'install', 'rm'].includes(c[0])).length, 0, 'validation stops before upload or deletion');
    assert.ok(!existsSync(join(bad.stage, 'ordinary-probes.json')), 'no box credential file');
    assert.equal(lstatSync(probeLocal(bad)).mode & 0o777, 0o600, 'local file retained privately');
    noProbeSecrets(bad, produced.receipt, result);
  });

  await t.test('negative: issuer refresh 400 stops without a retry or initialize', child => {
    const bad = probeFixture(child, { refresh_status: 400 });
    writeFileSync(probeLocal(bad), produced.bytes, { mode: 0o600 });
    pass(bad.run(['ai-w2-stage-probes'], 'W2', probeInputs(bad)), /PASS ai-w2-stage-probes/);
    prepareIssuer(bad, produced.receipt);
    const result = bad.run(['ai-w2-between-probes'], 'W2', { VERSION: '20261003000001' });
    stopped(result, 'FAIL ai-w2-between-probes: 20261003000001 refresh grant expected HTTP-200-Bearer-rotation got HTTP-400; STOP before next migration');
    const calls = probeState(bad).calls;
    assert.deepEqual(calls, [issuer + '/health', issuer + '/.well-known/oauth-authorization-server',
      issuer + '/.well-known/oauth-protected-resource/mcp', issuer + '/token']);
    assert.equal(calls.filter(url => url === issuer + '/token').length, 1, 'failed refresh is attempted exactly once');
    assert.ok(!existsSync(join(bad.proof, 'between-20261003000001.json')), 'no success proof after failed refresh');
    assert.equal(digest(readFileSync(join(bad.stage, 'ordinary-probes.json'))), digest(produced.bytes), 'failed refresh leaves the original file intact');
    assert.throws(() => lstatSync(probeLocal(bad)), { code: 'ENOENT' });
    noProbeSecrets(bad, produced.receipt, result);
  });
});

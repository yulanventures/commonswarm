// Test-audit: (1) protects the GitHub wire/storage/security contracts; (2) catches
// incomplete history, stale overwrites, lost acknowledgements and token leaks;
// (3) this is the primary API owner, controller tests own readiness/ACL lifecycle;
// (4) no production test seam: redirect transport and fixed receipt root only in
// disposable copies. Workflow source is the independent permission/bootstrap
// contract; do not duplicate it in controller tests. Root runs Linux gates.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repo=resolve(import.meta.dirname,'..');
const source=join(repo,'scripts/standalone-ci/publish-status.py');
const token='synthetic-status-only-token';
const legacy='csci-e6717ca3385d4f27a47cc52771525922';
const runID=n=>'csci-'+n.toString(16).padStart(32,'0');
const sha='1f5d731a986b56642fb527860af69866959d4465';
const receipt=(id=runID(1), overrides={})=>({run_id:id,requested_sha:'main',resolved_sha:sha,suite:'p1-cli',
  state:'completed',pending:false,exit_code:0,timed_out:false,cleanup_errors:[],
  started_at:'2026-10-18T00:00:00+00:00',ended_at:'2026-10-18T01:00:00+00:00',
  github_status:{state:'ready',version:1},...overrides});
function fixture(port) {
  const root=mkdtempSync(join(tmpdir(),'standalone-publisher.')), runs=join(root,'runs'); mkdirSync(runs);
  const script=join(root,'publisher.py');
  writeFileSync(script,`import http.client\nhttp.client.HTTPSConnection=lambda host,timeout: http.client.HTTPConnection('127.0.0.1',${port},timeout=timeout)\n`+
    readFileSync(source,'utf8').replace("RUNS = '/var/lib/commonswarm-ci/runs'",`RUNS = ${JSON.stringify(runs)}`));
  const put=value=>{const path=join(runs,value.run_id); mkdirSync(path,{recursive:true}); writeFileSync(join(path,'receipt.json'),JSON.stringify(value));};
  const invoke=(ids='',extra=[])=>new Promise((resolve,reject)=>{
    const child=spawn('python3',['-I',script,'--run-ids',ids,...extra],{env:{...process.env,GITHUB_TOKEN:token}});
    let stdout='',stderr=''; child.stdout.on('data',b=>stdout+=b); child.stderr.on('data',b=>stderr+=b);
    child.on('error',reject); child.on('exit',status=>{
      assert.equal((stdout+stderr).includes(token),false,'no secret in diagnostic output');
      resolve({status,stdout,stderr,result:stdout.trim() ? JSON.parse(stdout) : null});
    });
  });
  return {root,runs,script,put,invoke};
}
async function api(t,options={}) {
  const requests=[], rows=[]; let next=1000;
  const server=createServer(async(req,res)=>{
    let raw=''; for await(const part of req) raw+=part;
    const url=new URL(req.url,'http://localhost');
    const request={method:req.method,path:url.pathname,query:url.searchParams,authorization:req.headers.authorization,body:raw ? JSON.parse(raw) : null};
    requests.push(request);
    assert.equal(request.authorization,'Bearer '+token);
    if(options.reject?.(request,requests)) {res.writeHead(options.code ?? 403,{Location:'http://127.0.0.1:1/token-target'});res.end(token);return;}
    if(req.method==='GET') {
      const page=Number(url.searchParams.get('page'));
      let data=rows.filter(r=>r.sha===url.pathname.split('/').at(-2)).sort((a,b)=>b.id-a.id).map(({sha,...r})=>r);
      if(options.readbackMissing && requests.some(r=>r.method==='POST')) data=[];
      if(options.malformedPage===page) data={secret:token};
      else data=data.slice((page-1)*100,page*100);
      res.end(JSON.stringify(data)); return;
    }
    assert.equal(req.method,'POST'); assert.match(url.pathname,/\/statuses\/[0-9a-f]{40}$/);
    const row={...request.body,id:next++,sha:url.pathname.split('/').at(-1)};
    rows.push(row);
    if(options.losePost) {options.losePost=false;res.destroy();return;}
    res.writeHead(201);res.end(JSON.stringify(row));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {port:server.address().port,rows,requests,posts:()=>requests.filter(r=>r.method==='POST')};
}

test('terminal outcome mapping uses resolved SHA, curated metadata and readback; repeat skips',async t=>{
  const a=await api(t), f=fixture(a.port);
  const variants=[{}, {state:'failed',exit_code:9}, {state:'failed',exit_code:124,timed_out:true},
    {state:'failed',exit_code:1,cleanup_errors:[token]}, {state:'failed',exit_code:1,controller_error:token},
    ...[125,126,127].map(exit_code=>({state:'failed',exit_code,controller_error:'setup_command_failed'})),
    {state:'failed',exit_code:130}];
  variants.forEach((value,i)=>f.put(receipt(runID(i+1),{...value,ended_at:`2026-10-18T01:${String(i).padStart(2,'0')}:00Z`})));
  const result=await f.invoke(); assert.equal(result.status,0,result.stderr); assert.equal(result.result.published,variants.length);
  const posts=a.posts(); assert.equal(posts.length,variants.length);
  assert.deepEqual(posts.map(p=>p.body.state),['success','failure',...Array(7).fill('error')]);
  for(const p of posts) {
    assert.equal(p.path,'/repos/yulanventures/commonswarm/statuses/'+sha);
    assert.deepEqual(Object.keys(p.body).sort(),['context','description','state']);
    assert.equal(p.body.description.includes(token),false); assert.equal(p.body.context,'hetzner/p1-cli');
  }
  assert.ok(a.requests.length>=variants.length*3,'complete GET before and after each create');
  const again=await f.invoke(); assert.equal(again.status,0); assert.equal(again.result.skipped,variants.length); assert.equal(a.posts().length,variants.length);
});

test('full pagination finds older duplicate and refuses page failures before POST',async t=>{
  for(const fault of [false,true]) {
    const a=await api(t,fault?{malformedPage:2}:{}), f=fixture(a.port), r=receipt(); f.put(r);
    a.rows.push({id:1,sha,context:'hetzner/p1-cli',state:'success',description:r.run_id+' exit 0'});
    for(let n=2;n<=101;n++) a.rows.push({id:n,sha,context:'unrelated',state:'success',description:'other'});
    const result=await f.invoke(); assert.equal(result.status,fault?1:0); assert.equal(a.posts().length,0);
    assert.ok(a.requests.some(r=>r.query.get('page')==='2'));
    if(!fault) assert.equal(result.result.skipped,1);
  }
});

test('sorts completion times and blocks stale, equal or unknown history without using API insertion order',async t=>{
  const a=await api(t), f=fixture(a.port);
  f.put(receipt(runID(2),{ended_at:'2026-10-18T02:00:00Z'})); f.put(receipt());
  assert.equal((await f.invoke(runID(2)+','+runID(1))).status,0);
  assert.deepEqual(a.posts().map(r=>r.body.description.split(' ')[0]),[runID(1),runID(2)]);
  f.put(receipt(runID(3),{ended_at:'2026-10-18T01:30:00Z'}));
  assert.equal((await f.invoke(runID(3))).result.error,'newer_or_ambiguous_result');
  f.put(receipt(runID(4),{ended_at:'2026-10-18T02:00:00Z'}));
  assert.equal((await f.invoke(runID(4))).result.error,'newer_or_ambiguous_result');
  // A duplicate older run remains idempotent even after a newer run is current.
  assert.equal((await f.invoke(runID(1))).result.skipped,1);
  a.rows.push({id:9999,sha,context:'hetzner/p1-cli',state:'failure',description:'unattributed external writer'});
  f.put(receipt(runID(5),{ended_at:'2026-10-18T03:00:00Z'}));
  assert.equal((await f.invoke(runID(5))).result.error,'unknown_status_provenance');
  assert.equal(a.posts().length,2);
  // Different SHAs are independent of the conflicting context.
  f.put(receipt(runID(6),{resolved_sha:'a'.repeat(40)}));
  assert.equal((await f.invoke(runID(6))).status,0); assert.equal(a.posts().length,3);
});

test('legacy chronology resolves readable original receipt and fails on missing provenance',async t=>{
  for(const missing of [false,true]) {
    const a=await api(t), f=fixture(a.port);
    f.put(receipt(runID(2),{ended_at:'2026-10-18T02:00:00Z'}));
    if(!missing) f.put(receipt(runID(1)));
    a.rows.push({id:1,sha,context:'hetzner/p1-cli',state:'success',description:runID(1)+' exit 0'});
    const result=await f.invoke(runID(2)); assert.equal(result.status,missing?1:0); assert.equal(a.posts().length,missing?0:1);
  }
});

test('lost POST response reconciles next invocation and missing readback never reports published',async t=>{
  for(const options of [{losePost:true},{readbackMissing:true}]) {
    const a=await api(t,options), f=fixture(a.port); f.put(receipt());
    const first=await f.invoke(); assert.equal(first.status,1); assert.equal(first.result.state,'failed'); assert.equal(a.posts().length,1);
    options.readbackMissing=false;
    const again=await f.invoke(); assert.equal(again.status,0); assert.equal(again.result.skipped,1); assert.equal(a.posts().length,1);
  }
});

test('scheduled discovery ignores unfinished and legacy; explicit legacy accepts only the six audited IDs',async t=>{
  const a=await api(t), f=fixture(a.port);
  f.put(receipt(legacy,{github_status:undefined}));
  f.put(receipt(runID(1),{github_status:undefined,state:'deferred',pending:true,exit_code:75}));
  const empty=await f.invoke(); assert.equal(empty.status,0); assert.equal(empty.result.eligible,0); assert.equal(a.requests.length,0);
  assert.equal((await f.invoke(legacy)).result.published,1);
  f.put(receipt(runID(2),{github_status:undefined}));
  assert.equal((await f.invoke(runID(2))).result.error,'selected_receipt_not_ready');
  f.put(receipt(legacy,{github_status:undefined,state:'deferred',pending:true,exit_code:75}));
  assert.equal((await f.invoke(legacy)).result.error,'unfinished_result');
  assert.equal(a.posts().length,1);
});

test('receipt validation and path refusals are reached with a successful control; receipt files stay unchanged',async t=>{
  const a=await api(t), f=fixture(a.port); f.put(receipt());
  const file=join(f.runs,runID(1),'receipt.json'), before=readFileSync(file);
  assert.equal((await f.invoke()).status,0); assert.deepEqual(readFileSync(file),before);
  for(const changes of [{resolved_sha:'main'},{suite:'arbitrary'},{state:'failed'},{pending:true},
    {timed_out:'yes'},{cleanup_errors:'bad'},{controller_error:token},{exit_code:-1},
    {ended_at:'2026-10-18T01:00:00'},{ended_at:'2026-10-17T01:00:00Z'},
    {ended_at:'2999-01-01T00:00:00Z'},{run_id:runID(2)}]) {
    writeFileSync(file,JSON.stringify({...receipt(),...changes}));
    assert.equal((await f.invoke(runID(1))).status,1,JSON.stringify(changes));
  }
  for(const value of ['../x','main',runID(1)+','+runID(1),Array.from({length:21},(_,i)=>runID(i+1)).join(',')]) assert.equal((await f.invoke(value)).status,1);
  for(const flag of ['--sha','--config','--receipt']) assert.equal((await f.invoke('', [flag,'forbidden'])).status,2);
  // Each symlink probe is reached after valid input and successful HTTP above.
  const outside=join(f.root,'outside'); writeFileSync(outside,JSON.stringify(receipt(runID(3))));
  mkdirSync(join(f.runs,runID(3))); symlinkSync(outside,join(f.runs,runID(3),'receipt.json'));
  assert.equal((await f.invoke(runID(3))).status,1);
  symlinkSync(join(f.runs,runID(1)),join(f.runs,runID(4)));
  assert.equal((await f.invoke(runID(4))).status,1);
  writeFileSync(file,' '.repeat(1048577));
  assert.equal((await f.invoke(runID(1))).result.error,'unsafe_receipt');
  assert.equal(a.posts().length,1);
});

test('HTTP errors and redirects never forward credentials or expose response text',async t=>{
  for(const method of ['GET','POST']) for(const code of [302,403,500]) {
    const a=await api(t,{reject:r=>r.method===method,code}), f=fixture(a.port); f.put(receipt());
    const result=await f.invoke(); assert.equal(result.status,1); assert.equal(result.result.error,'github_http_'+code);
    assert.equal(a.requests.length,method==='GET'?1:2); assert.equal(a.posts().length,method==='GET'?0:1);
  }
});

test('workflow independently restricts permissions, trusted triggers, runner and installed publisher bootstrap',()=>{
  const workflow=readFileSync(join(repo,'.github/workflows/hetzner-status.yml'),'utf8');
  assert.match(workflow,/permissions:\n  statuses: write\n/);
  assert.equal((workflow.match(/permissions:/g)||[]).length,1);
  assert.match(workflow,/cron: '40 \* \* \* \*'/); assert.match(workflow,/workflow_dispatch:/);
  assert.doesNotMatch(workflow,/pull_request|push:|uses:|contents:|actions: write/);
  assert.match(workflow,/github.repository == 'yulanventures\/commonswarm'/);
  assert.match(workflow,/github.ref == 'refs\/heads\/main'/);
  assert.match(workflow,/runs-on: \[self-hosted, Linux, X64, pe-ci-1, commonswarm-status\]/);
  assert.match(workflow,/cancel-in-progress: false/);
  assert.equal((workflow.match(/\$\{\{/g)||[]).length,2,'expressions occur only in env entries');
  const pin=createHash('sha256').update(readFileSync(source)).digest('hex');
  assert.ok(workflow.includes("!= '"+pin+"'"),'actual reviewed publisher bytes pinned');
  // Execute the actual bootstrap with syscall/host boundary fixtures, not a
  // duplicate source-grep for its admission rules. No execution of publisher.
  const bootstrap=workflow.split("python3 -I - <<'PY'\n")[1].split('\n          PY')[0].split('\n').map(l=>l.slice(10)).join('\n');
  const harness=`import os,pathlib,pwd,socket,stat,hashlib,sys\nos.getuid=lambda:1234\npwd.getpwnam=lambda name:type('Account',(),{'pw_uid':1234})()\nsource=${JSON.stringify(readFileSync(source,'utf8'))}.encode()\nmode=os.environ['CASE']\nsocket.gethostname=lambda:'wrong' if mode=='host' else 'pe-ci-1'\npathlib.Path.lstat=lambda self:type('Info',(),{'st_uid':1 if mode=='owner' else 0,'st_mode':stat.S_IFREG| (0o777 if mode=='write' else 0o755)})()\npathlib.Path.is_file=lambda self:True\npathlib.Path.read_bytes=lambda self:source if mode!='hash' else b'tampered'\nos.execv=lambda *args:sys.exit(42)\n`;
  for(const kind of ['ok','host','owner','write','hash','ref']) {
    const r=spawnSync('python3',['-I','-c',harness+'\n'+bootstrap],{encoding:'utf8',env:{...process.env,CASE:kind,GITHUB_REPOSITORY:'yulanventures/commonswarm',GITHUB_REF:kind==='ref'?'refs/heads/untrusted':'refs/heads/main'}});
    assert.equal(r.status,kind==='ok'?42:1,r.stderr);
  }
});

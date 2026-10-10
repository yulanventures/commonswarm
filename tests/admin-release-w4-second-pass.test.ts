/** W4 second pass (build B): run the complete marked W4 blocks against a post-first-W4 box with the archive keeper
 * installed; remap only filesystem roots, root ownership and external observations. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync,
  statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import { ADMIN_READ_RESOURCES } from '../src/cloud/admin-delegations-contract.js';

const planPath = resolve('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md');
const plan = readFileSync(planPath, 'utf8');
const planBytes = readFileSync(planPath);
const blocksOf = (source: string) => [...source.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!);
const blocks = blocksOf(plan);
const has = (step: string) => blocks.some(source => source.startsWith(`# step: ${step}\n`));
const block = (step: string) => {
  const found = blocks.filter(source => source.startsWith(`# step: ${step}\n`));
  assert.equal(found.length, 1, `one complete ${step} block in the plan`);
  return found[0]!;
};
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const temporaryRoot = realpathSync(tmpdir());
const scratch = realpathSync(mkdtempSync(join(temporaryRoot, 'admin-w4b-')));
const realHome = realpathSync(homedir());
assert.equal(dirname(scratch), temporaryRoot);
assert.ok(scratch !== realHome && !scratch.startsWith(realHome + sep));
after(() => {
  assert.equal(dirname(scratch), temporaryRoot);
  assert.match(scratch.slice(temporaryRoot.length + 1), /^admin-w4b-[A-Za-z0-9]{6}$/);
  const cleanup = spawnSync('rm', ['-r', '--', scratch], { encoding: 'utf8' });
  assert.equal(cleanup.status, 0, `fixture cleanup refused ${scratch}: ${cleanup.stderr}`);
});

// The legacy hook is the exact first-pass hook: the block at the base commit of this lane.
const baseCommit = '7efbb67df10abec01c624deb4e89a05a0badfc49';
const basePlan = spawnSync('git', ['show', `${baseCommit}:docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md`], { encoding: 'utf8', maxBuffer: 64 << 20 });
assert.equal(basePlan.status, 0, `base commit ${baseCommit} is absent from this clone: fetch it (fetch-depth: 0) ${basePlan.stderr}`);
const legacyHook = '#!/bin/bash\n' + blocksOf(basePlan.stdout).find(b => b.startsWith('# step: ai-recycle-hook\n'))!;
assert.equal(hash(legacyHook), '3f03038e7dde0e6402f3359f4abcf5815d847ca3d7fefcefa8ec0e31c7a5b5e6', 'measured first-pass hook digest');
const candidateHook = '#!/bin/bash\n' + block('ai-recycle-hook');

const sha = 'a'.repeat(40), baseline = 'b'.repeat(40), wid = 'Fix123', legacyWid = 'E3571B';
const edgeImage = 'sha256:' + 'c'.repeat(64), postgresImage = 'sha256:' + 'd'.repeat(64);
const service = 'commonswarm-edge-recycle.service', timer = 'commonswarm-edge-recycle.timer';
const producerSource = 'export const fixtureProducer = "live-ordinary-controls";\n';
const keeperUnits = ['commonswarm-recycle-archive-keep.timer', 'commonswarm-recycle-archive-keep.service', 'commonswarm-recycle-archive-restore.service'];
const keeperLinks = ['timers.target.wants/commonswarm-recycle-archive-keep.timer', 'multi-user.target.wants/commonswarm-recycle-archive-keep.service',
  'multi-user.target.wants/commonswarm-recycle-archive-restore.service'];
const varsName = 'keeper-install-20261010T165121Z.vars';

// Root-relative fixture names for the production paths the W4 blocks touch.
const remaps: Array<[string, string]> = [
  ['/private/tmp/admin-issuance-prep', 'mac-tmp/admin-issuance-prep'], ['/etc/caddy', 'etc/caddy'], ['/home/commonswarm/edge', 'edge'], ['/home/commonswarm/.env', 'box/.env'],
  ['/home/commonswarm/admin-issuance', 'admin-issuance'], ['/tmp/admin-issuance-', 'tmp/admin-issuance-'],
  ['/proof/w4-rollback-measure.sql', 'proof/w4-rollback-measure.sql'], ['/proof/measure.sql', 'proof/measure.sql'], ['/etc/systemd/system', 'systemd'], ['/usr/local/libexec', 'libexec'],
  ['/etc/commonswarm-admin-release', 'admin-release'], ['/var/lib/commonswarm-admin-release', 'var-lib-admin-release'],
  ['/var/lib/commonswarm-release', 'var-lib-release'], ['/etc/tmpfiles.d', 'tmpfiles.d'], ['/root/keeper-install-', 'root/keeper-install-'],
  ['/root/recycle-archive-keeper', 'keeper-bundle'], ['/tmp/anvil-secret', 'tmp/anvil-secret'],
];
// The plan's reviewed drop-in, as the fixture's remapped hook path names it.
const reviewedDropin = (root: string) => `[Service]\nEnvironment=COMMONSWARM_RECYCLE_UNIT=%n\nExecStartPre=${root}/libexec/commonswarm-admin-edge-recycle before\nExecStartPost=${root}/libexec/commonswarm-admin-edge-recycle after\n`;

function consentReceipt(change: Record<string, unknown> = {}) {
  return { kind: 'c1-consent', release_sha: sha, live_edge_sha: baseline, consent_phase: 'pre-W1', measured_at: new Date(Date.now() - 60_000).toISOString(),
    producer_sha256: hash(producerSource), controls: { cimd_consent: true, dcr_registration_consent: true }, dcr_client_ids: ['dcr-pre-w1-1'], cleanup: null, ...change };
}
function liveReceipt(phase: string, consentText: string, edge: string) {
  return { release_sha: sha, live_edge_sha: edge, window_id: wid, window: 'W4', phase,
    controls: Object.fromEntries(['hosted_mcp_consent_refresh', 'dcr_registration_consent', 'cimd_consent', 'human_recovery', 'worker_command_read'].map(k => [k, true])),
    consent_receipt_sha256: hash(consentText), producer_sha256: hash(producerSource), dcr_client_ids: ['dcr-w4-1'] };
}

// Every command records argv. PATH holds only these stubs. Python runs the plan's own source in-process and
// replaces only external observations: root ownership (the test user's uid/gid read as 0), the clock, fchown,
// systemd, Docker, the database and the host name.
const dispatcher = String.raw`#!/usr/bin/python3
import datetime,hashlib,io,json,os,pathlib,shutil,socket,stat,subprocess,sys
root=pathlib.Path(os.environ['W4B_ROOT']); cfg=json.loads((root/'fixture.json').read_text())
name=pathlib.Path(sys.argv[0]).name; args=sys.argv[1:]
with (root/'commands.jsonl').open('a') as log: log.write(json.dumps([name]+args)+'\n')
if [name]+args in cfg.get('fail_calls',[]): raise SystemExit(1)
def refuse(*a,**kw): raise RuntimeError('UNMODELLED '+name+' '+repr(args))
def owned(value):
    p=pathlib.Path(value)
    if not p.is_absolute() or not (str(p)+'/').startswith(str(root)+'/'): refuse()
    return p
def load(file,default):
    p=root/file
    return json.loads(p.read_text()) if p.exists() else default
def save(file,value): (root/file).write_text(json.dumps(value,sort_keys=True))
socket.socket.connect=refuse; socket.create_connection=refuse
clock=cfg.get('clock','2026-10-10T12:00:00Z')
UNIT_DIR=root/'systemd'
def unit_cat(u):
    out='# /etc/systemd/system/'+u+'\n'+(UNIT_DIR/u).read_text()
    d=UNIT_DIR/(u+'.d')
    if d.is_dir():
        for c in sorted(d.iterdir()): out+='\n# /etc/systemd/system/'+u+'.d/'+c.name+'\n'+c.read_text()
    return out
if name=='python3':
    if args and args[0]=='-': source=sys.stdin.read(); sys.argv=['-']+args[1:]
    elif len(args)>=2 and args[0]=='-c': source=args[1]; sys.argv=['-c']+args[2:]
    else: refuse()
    fixed=datetime.datetime.strptime(clock,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
    class FixedDateTime(datetime.datetime):
        @classmethod
        def now(cls,tz=None): return fixed.astimezone(tz) if tz is not None else fixed.replace(tzinfo=None)
        @classmethod
        def utcnow(cls): return fixed.replace(tzinfo=None)
    datetime.datetime=FixedDateTime
    # Ownership boundary: the test user's files read as root:root; cfg owners names a path's other owner.
    uid0,gid0=os.getuid(),os.getgid(); owners=cfg.get('owners',{}); fdpath={}
    real_stat,real_lstat,real_fstat,real_open,real_close=os.stat,os.lstat,os.fstat,os.open,os.close
    def rel(path):
        try: p=os.path.abspath(os.fsdecode(path))
        except TypeError: return None
        return os.path.relpath(p,str(root)) if (p+'/').startswith(str(root)+'/') else None
    def as_root(st,path):
        uid,gid=(0 if st.st_uid==uid0 else st.st_uid),(0 if st.st_gid==gid0 else st.st_gid)
        key=rel(path) if path is not None else None
        if key in owners: uid,gid=owners[key]
        return os.stat_result((st.st_mode,st.st_ino,st.st_dev,st.st_nlink,uid,gid,st.st_size,int(st.st_atime),int(st.st_mtime),int(st.st_ctime)))
    def stat_(path,*a,**kw):
        st=real_stat(path,*a,**kw)
        return as_root(st,fdpath.get(path) if isinstance(path,int) else (path if kw.get('follow_symlinks',True) is False else os.path.realpath(path)))
    def lstat_(path,*a,**kw): return as_root(real_lstat(path,*a,**kw),path)
    def fstat_(fd): return as_root(real_fstat(fd),fdpath.get(fd))
    def open_(path,flags,*a,**kw):
        fd=real_open(path,flags,*a,**kw); fdpath[fd]=os.path.realpath(path) if not flags & getattr(os,'O_NOFOLLOW',0) else os.path.abspath(path); return fd
    def close_(fd):
        fdpath.pop(fd,None); return real_close(fd)
    os.stat,os.lstat,os.fstat,os.open,os.close=stat_,lstat_,fstat_,open_,close_
    if hasattr(pathlib,'_NormalAccessor'):
        # Python 3.9 pathlib bound the os functions at import; route its accessor through the same remap.
        for attr,fn in (('stat',stat_),('lstat',lstat_),('open',open_)): setattr(pathlib._NormalAccessor,attr,staticmethod(fn))
    def fchown(fd,uid,gid):
        with (root/'fchown.jsonl').open('a') as log: log.write(json.dumps([rel(fdpath.get(fd,'')),uid,gid])+'\n')
    os.fchown=fchown
    def chown(path,uid,gid,*a,**kw):
        with (root/'fchown.jsonl').open('a') as log: log.write(json.dumps([rel(path),uid,gid])+'\n')
    os.chown=chown
    real_replace,real_rename=os.replace,os.rename
    def replace(src,dst,*a,**kw):
        if rel(dst) in cfg.get('interrupt_replace',[]): raise OSError('fixture interruption before rename of '+str(rel(dst)))
        return real_replace(src,dst,*a,**kw)
    os.replace=replace
    def rename(src,dst,*a,**kw):
        if rel(dst) in cfg.get('interrupt_replace',[]): raise OSError('fixture interruption before rename of '+str(rel(dst)))
        return real_rename(src,dst,*a,**kw)
    os.rename=rename
    real_fsync=os.fsync
    def fsync(fd):
        # A fault after the full write and before the plan's read-back: one extra byte on the named file.
        if rel(fdpath.get(fd,'')) in cfg.get('corrupt_write',[]): os.write(fd,b'#')
        return real_fsync(fd)
    os.fsync=fsync
    stubs=set(os.listdir(str(root/'bin')))
    real_popen=subprocess.Popen
    def popen(argv,*a,**kw):
        if kw.get('shell') or not isinstance(argv,list) or not argv: refuse()
        if not (argv[0] in stubs or argv[0]=='/bin/bash'): refuse()
        return real_popen(argv,*a,**kw)
    subprocess.Popen=popen
    exec(compile(source,'<complete-plan-block>','exec'),{'__name__':'__main__','__builtins__':__builtins__})
elif name=='systemctl':
    units=load('units.json',{})
    a=[x for x in args if x!='--quiet']; quiet='--quiet' in args
    def unit(u): return units.setdefault(u,{'load':'not-found','active':'inactive','enabled':'not-found'})
    if a[:1]==['show']:
        prop=value=u=None; i=1
        while i<len(a):
            if a[i]=='-p': prop=a[i+1]; i+=2
            elif a[i]=='--value': value=True; i+=1
            else: u=a[i]; i+=1
        if not value or u is None or prop not in ('ActiveState','LoadState'): refuse()
        print(unit(u)['active' if prop=='ActiveState' else 'load'])
    elif a[:1]==['is-active'] and len(a)==2:
        state=unit(a[1])['active']
        if not quiet: print(state)
        raise SystemExit(0 if state=='active' else 3)
    elif a[:1]==['is-enabled'] and len(a)==2:
        state=unit(a[1])['enabled']; print(state); raise SystemExit(0 if state=='enabled' else 1)
    elif a[:1] in (['stop'],['start']) and len(a)==2:
        unit(a[1])['active']='inactive' if a[0]=='stop' else 'active'; save('units.json',units)
    elif a[:2]==['disable','--now'] and len(a)>2:
        for u in a[2:]:
            unit(u).update(active='inactive',enabled='disabled')
            for wants in UNIT_DIR.glob('*.wants'):
                if os.path.lexists(wants/u): (wants/u).unlink()
        save('units.json',units)
    elif a==['daemon-reload']:
        for u,v in units.items():
            if u.startswith('commonswarm-recycle-archive') and not os.path.lexists(UNIT_DIR/u): v.update(load='not-found',active='inactive',enabled='not-found')
        save('units.json',units)
    elif a==['reload','caddy']: pass
    elif a[:1]==['cat'] and len(a)==2: print(unit_cat(a[1]))
    else: refuse()
elif name in ('ssh','scp'):
    # Mac transport: record only; a remote sha256sum answers with the uploaded file's digest (or a configured one).
    with (root/'transport.jsonl').open('a') as log: log.write(json.dumps([name]+args)+'\n')
    if name=='ssh' and args[-1].startswith('sha256sum -- '):
        target=args[-1][len('sha256sum -- '):]
        print(cfg.get('remote_digest') or hashlib.sha256((root/'remote'/os.path.basename(target)).read_bytes()).hexdigest(),'',target)
    elif name=='scp':
        (root/'remote').mkdir(exist_ok=True); shutil.copyfile(owned(args[1]),root/'remote'/os.path.basename(args[2].split(':',1)[1]))
elif name=='shasum':
    if args[:2]!=['-a','256'] or len(args)!=3: refuse()
    print(hashlib.sha256(owned(args[2]).read_bytes()).hexdigest()+'  '+args[2])
elif name=='git':
    head=cfg.get('git',{})
    if args==['status','--porcelain']: pass
    elif args==['fetch','origin','main']: pass
    elif args[:2]==['rev-parse','--verify']: print(head['rev'][args[2].split('^')[0]])
    elif args[:2]==['merge-base','--is-ancestor']: pass
    elif args==['remote','get-url','origin']: print('git@github.com:yulanventures/commonswarm.git')
    elif args[:3]==['archive','--format=tar',cfg['sha']]: sys.stdout.buffer.write(owned(head['archive']).read_bytes())
    elif len(args)==2 and args[0]=='show' and args[1]==cfg['sha']+':docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md': sys.stdout.buffer.write(owned(head['plan']).read_bytes())
    else: refuse()
elif name in ('ai_db','ai_ro'):
    db=load('cutover.json',{}); a=args
    close="BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,invalidated_at=statement_timestamp(),release_generation=release_generation+1 WHERE singleton; COMMIT;"
    queries={
     'SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;':lambda: 't' if not db['enabled'] and db['invalidated'] else 'f',
     'SELECT release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton AND invalidated_at IS NULL AND measured_generation=release_generation;':lambda: str(db['generation']) if not db['invalidated'] and db['measured_generation']==db['generation'] else '',
     'SELECT NOT admin_issuance_enabled AND legacy_closed AND invalidated_at IS NULL AND measured_generation=release_generation AND measured_edge_release_sha=approved_edge_release_sha FROM commonswarm_oauth.admin_cutover_state WHERE singleton;':lambda: 't' if not db['enabled'] and not db['invalidated'] and db['measured_generation']==db['generation'] and db['measured']==db['approved'] else 'f',
     'SELECT count(*) FROM commonswarm_ops.migration_checksum_failures();':lambda: '0',
     "SELECT NOT EXISTS(SELECT 1 FROM swarm.admin_grants WHERE registry_version=1 AND state='active') AND NOT has_table_privilege('swarm_command','swarm.admin_credentials','SELECT,INSERT,UPDATE') AND (SELECT relforcerowsecurity FROM pg_class WHERE oid='swarm.admin_credentials'::regclass);":lambda: 't',
     'SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;':lambda: 't' if not db['enabled'] else 'f',
     'SELECT release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton;':lambda: str(db['generation']),
     "SELECT json_build_object('admin_issuance_enabled',admin_issuance_enabled,'invalidated',invalidated_at IS NOT NULL,'release_generation',release_generation,'measured_generation',measured_generation,'measured_edge_release_sha',measured_edge_release_sha)::text FROM commonswarm_oauth.admin_cutover_state WHERE singleton;":lambda: json.dumps({'admin_issuance_enabled':db['enabled'],'invalidated':db['invalidated'],'release_generation':db['generation'],'measured_generation':db['measured_generation'],'measured_edge_release_sha':db['measured']}),
    }
    def measured_projection():
        m=db.get('identities',{})
        return json.dumps({'admin_issuance_enabled':db['enabled'],'invalidated':db['invalidated'],'release_generation':db['generation'],
            'measured_generation':db['measured_generation'],'measured_edge_release_sha':db['measured'],
            'measured_edge_target':m.get('target'),'measured_mount':m.get('mount'),'measured_image_digest':m.get('image_digest'),
            'measured_artifact_digest':m.get('artifact_digest'),'measured_at':db.get('measured_at'),'measurement_evidence_ref':db.get('evidence_ref')})
    for q,v in cfg.get('db_answers',{}).items(): queries[q]=(lambda v=v: v)
    # ai-w4-apply's A6 readbacks, keyed on stable parts of their SQL: the fence projection and the 19-column singleton.
    def fence():
        closed=db.get('legacy_closed',True)
        return json.dumps({'admin_issuance_enabled':db['enabled'],'legacy_closed':closed,'fence_complete':closed and not cfg.get('fence_drift')})
    def singleton():
        stamp=lambda flag: '2026-10-10T12:00:00+00:00' if flag else None
        measured=db['measured']; target='/home/commonswarm/edge/releases/'+measured if measured else None
        return json.dumps({'singleton':True,'admin_issuance_enabled':db['enabled'],'legacy_closed':db.get('legacy_closed',True),'legacy_closed_at':stamp(db.get('legacy_closed',True)),
            'legacy_fence_evidence_ref':'W4/E3571B/ai-w4-apply','approved_edge_release_sha':db['approved'],'auth_contract_version':2,'required_migrations':{},
            'lane8_evidence_digest':None,'measured_edge_release_sha':measured,'measured_edge_target':target,'measured_artifact_digest':'f'*64,
            'measured_image_digest':cfg['image'],'measured_mount':target,'release_generation':db['generation'],'measured_generation':db['measured_generation'],
            'measured_at':stamp(True),'measurement_evidence_ref':'fixture','invalidated_at':stamp(db['invalidated'])})
    if name=='ai_db' and a==['-q','--command',close]:
        db.update(enabled=False,invalidated=True,generation=db['generation']+1); save('cutover.json',db)
    elif name=='ai_db' and a==['-q','--file',str(root/'proof/measure.sql')]:
        sql=owned(a[2]).read_text(); assert 'apply_legacy_admin_fence' in sql and "measured_edge_release_sha='"+cfg['sha']+"'" in sql
        db.update(enabled=False,invalidated=False,generation=db['generation']+1,measured_generation=db['generation']+1,measured=cfg['sha'],approved=cfg['sha'],legacy_closed=True); save('cutover.json',db)
    elif len(a)==3 and a[:2]==['-Atq','--command'] and a[2] in queries: print(queries[a[2]]())
    elif name=='ai_ro' and len(a)==3 and a[:2]==['-Atq','--command'] and "'fence_complete'," in a[2] and 'revoked_roles' in a[2]: print(fence())
    elif name=='ai_ro' and len(a)==3 and a[:2]==['-Atq','--command'] and a[2].startswith("SELECT json_build_object('admin_issuance_enabled',admin_issuance_enabled,") and "'measured_edge_target'," in a[2]: print(measured_projection())
    elif name=='ai_db' and a==['-q','--file',str(root/'proof/w4-rollback-measure.sql')]:
        import re
        sql=owned(a[2]).read_text()
        fields=dict(re.findall(r"(measured_edge_release_sha|measured_edge_target|measured_mount|measured_image_digest|measured_artifact_digest|measurement_evidence_ref)='([^']*)'",sql))
        assert len(fields)==6 and 'measured_generation=release_generation+1' in sql and 'invalidated_at=statement_timestamp()' in sql and not db['enabled']
        db.update(enabled=False,invalidated=True,generation=db['generation']+1,measured_generation=db['generation']+1,
            measured=fields['measured_edge_release_sha'],measured_at=clock,evidence_ref=fields['measurement_evidence_ref'],
            identities={k:fields[v] for k,v in [('target','measured_edge_target'),('mount','measured_mount'),('image_digest','measured_image_digest'),('artifact_digest','measured_artifact_digest')]})
        save('cutover.json',db)
    elif name=='ai_ro' and len(a)==3 and a[:2]==['-Atq','--command'] and a[2].startswith("SELECT json_build_object('singleton',singleton,"): print(singleton())
    else: refuse()
elif name=='docker':
    edge=load('docker.json',{}); live=edge['working_dir']; rel_=live[:-len('/deploy/edge-runtime')]
    def compose_files(d): return [d+'/compose.yaml',d+'/compose.override.yaml']
    if args==['inspect','--format','{{.State.Health.Status}}','commonswarm-edge-edge-runtime-1']: print('healthy')
    elif args==['inspect','--format','{{.Image}}','commonswarm-edge-edge-runtime-1']: print(cfg.get('running_image',cfg['image']))
    elif args==['inspect','--format','{{index .Config.Labels "com.docker.compose.project.working_dir"}}','commonswarm-edge-edge-runtime-1']: print(live)
    elif args==['inspect','--format','{{index .Config.Labels "com.docker.compose.project.config_files"}}','commonswarm-edge-edge-runtime-1']: print(','.join(compose_files(live)))
    elif args==['inspect','commonswarm-edge-edge-runtime-1']:
        print(json.dumps([{'Image':cfg['image'],'State':{'Health':{'Status':'healthy'}},'Config':{'Labels':{'com.docker.compose.project.working_dir':live},'Env':['PATH=/usr/bin','SWARM_MCP_PUBLIC_ENABLED=1']},
            'HostConfig':{'NetworkMode':'commonswarm-net','Memory':2147483648},'Mounts':[{'Destination':dst,'Source':(rel_ if not cfg.get('mount_drift') else str(root/'edge/releases'/cfg['sha']))+'/'+src,'RW':False} for dst,src in [('/home/deno/main','deploy/edge-runtime/main'),('/home/deno/functions-source','supabase/functions'),('/var/src','src')]]}]))
    elif args==['image','inspect',cfg['image']]: print(json.dumps([{'Config':{'Env':['PATH=/usr/bin']}}]))
    elif args[:2]==['run','--rm'] and '--entrypoint' in args and args[args.index('--entrypoint')+1]=='psql':
        # The recycle hook's database session: answer each read-only-mounted statement file it writes.
        statement=[v.split(':')[0] for v in args if v.endswith(':/run/statement.sql:ro')]
        sql=owned(statement[0]).read_text() if len(statement)==1 else refuse()
        with (root/'hook-sql.jsonl').open('a') as log: log.write(json.dumps(sql)+'\n')
        db=load('cutover.json',{})
        if 'RETURNING release_generation' in sql:
            db.update(enabled=False,invalidated=True,generation=db['generation']+1); save('cutover.json',db); print('f\n'+str(db['generation']))
        elif sql.startswith('SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL'): print('t' if not db['enabled'] and db['invalidated'] else 'f')
        elif sql.startswith('BEGIN; DO $$'):
            db.update(invalidated=False,measured_generation=db['generation'],measured=cfg['sha']); save('cutover.json',db)
        elif 'FOR UPDATE' in sql:
            db.update(enabled=False,invalidated=True,generation=db['generation']+1); save('cutover.json',db); print('f')
        else: refuse()
    elif len(args)>=8 and args[:3]==['compose','--project-name','commonswarm-edge'] and args[3]=='-f' and args[5]=='-f':
        if os.environ.get('COMMONSWARM_EDGE_NETWORK_MODE')!='commonswarm-net': refuse()
        d=os.path.dirname(owned(args[4])); assert [args[4],args[6]]==compose_files(d)
        if args[7:]==['config','--format','json']:
            print(json.dumps({'services':{'edge-runtime':{'network_mode':'commonswarm-net','mem_limit':'2147483648','environment':{'SWARM_MCP_PUBLIC_ENABLED':'1'}}}}))
        elif args[7:]==['up','-d','--no-build','--pull','never','--force-recreate','edge-runtime']:
            edge['working_dir']=d; save('docker.json',edge)
        else: refuse()
    else: refuse()
elif name=='node':
    # make-pg-service.mjs writes the private service and password files the hook mounts read-only.
    if len(args)!=1 or not args[0].endswith('/deploy/supabase-stack/migrate/make-pg-service.mjs'): refuse()
    for key in ('PG_SERVICE_OUTPUT','PG_PASS_OUTPUT'): owned(os.environ[key]).write_text('fixture '+key+'\n')
elif name=='logger':
    with (root/'logger.jsonl').open('a') as log: log.write(json.dumps(args)+'\n')
elif name=='mktemp':
    if len(args)!=2 or args[0]!='-d' or not args[1].endswith('.XXXXXX'): refuse()
    import random,string
    d=owned(args[1][:-6]+''.join(random.choice(string.ascii_letters+string.digits) for _ in range(6))); d.mkdir(mode=0o700); print(d)
elif name=='date':
    if args!=['-u','+%Y-%m-%dT%H:%M:%SZ']: refuse()
    print(clock)
elif name=='hostname':
    if args: refuse()
    print(cfg.get('hostname','yulan-vps-1'))
elif name=='sha256sum':
    if args[:1]==['-c']:
        if args!=['-c','SHA256SUMS']: refuse()
        here=owned(os.getcwd()); bad=0
        for line in (here/'SHA256SUMS').read_text().splitlines():
            digest,file=line.split('  ',1); p=here/file
            ok=p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest()==digest
            print(file+': '+('OK' if ok else 'FAILED')); bad+=not ok
        raise SystemExit(1 if bad else 0)
    if not args: refuse()
    for a in args: print(hashlib.sha256(owned(a).read_bytes()).hexdigest()+'  '+a)
elif name=='rm':
    a=list(args); recursive=a[:1]==['-r']
    if recursive: a=a[1:]
    if a[:1]==['--']: a=a[1:]
    if len(a)!=1: refuse()
    p=owned(a[0])
    if os.path.relpath(str(p),str(root)) in cfg.get('rm_refuse',[]): print('rm guard: refused '+str(p),file=sys.stderr); raise SystemExit(1)
    if p.is_dir() and not p.is_symlink():
        if not recursive: raise SystemExit(1)
        shutil.rmtree(p)
    else: p.unlink()
elif name=='rmdir':
    a=args[1:] if args[:1]==['--'] else args
    if len(a)!=1: refuse()
    owned(a[0]).rmdir()
elif name=='awk':
    if args!=['{print $1}']: refuse()
    print(sys.stdin.read().split()[0])
elif name=='mkdir':
    if args[:1]==['-p']:
        for v in args[1:]: owned(v).mkdir(parents=True,exist_ok=True)
    elif len(args)==1: owned(args[0]).mkdir()
    else: refuse()
elif name=='cp':
    if len(args)==3 and args[0]=='-a' and args[1].endswith('/.'): shutil.copytree(owned(args[1]),owned(args[2]),dirs_exist_ok=True,symlinks=True)
    elif len(args)==2: shutil.copyfile(owned(args[0]),owned(args[1]))
    else: refuse()
elif name=='chmod':
    if args==['-R','go-rwx',str(root/'stage')]:
        for p in [root/'stage']+list((root/'stage').rglob('*')): p.chmod(p.stat().st_mode & ~0o077)
    elif len(args)>=2 and all(c in '01234567' for c in args[0]):
        for v in args[1:]: owned(v).chmod(int(args[0],8))
    else: refuse()
elif name=='caddy':
    if args not in [['validate','--config',str(root/'stage/Caddyfile'),'--adapter','caddyfile'],['validate','--config',str(root/'etc/caddy/Caddyfile'),'--adapter','caddyfile']]: refuse()
    if not owned(args[2]).is_file(): refuse()
    raise SystemExit(cfg.get('caddy_status',0))
elif name=='ai_deadline':
    if args: refuse()
elif name=='ai_run':
    if len(args)!=1: refuse()
    if args==['ai-backup-gate-check'] and cfg.get('backup_gate_refused'): raise SystemExit(1)
elif name=='cmp':
    if len(args)!=3 or args[0]!='-s': refuse()
    raise SystemExit(0 if owned(args[1]).read_bytes()==owned(args[2]).read_bytes() else 1)
elif name=='ln':
    if len(args)!=3 or args[0]!='-sfT': refuse()
    link=owned(args[2])
    if link.is_symlink(): link.unlink()
    elif link.exists(): raise SystemExit(1)
    link.symlink_to(owned(args[1]),target_is_directory=True)
elif name=='mv':
    if len(args)!=3 or args[0]!='-Tf': refuse()
    owned(args[1]).replace(owned(args[2]))
elif name=='timeout':
    expected='until test "$(docker inspect --format "{{.State.Health.Status}}" commonswarm-edge-edge-runtime-1)" = healthy; do sleep 2; done'
    if args!=['90','/bin/bash','-c',expected]: refuse()
    raise SystemExit(subprocess.run(args[1:]).returncode)
elif name=='install':
    if len(args)==8 and args[:7]==['-d','-o','root','-g','root','-m','0700']:
        owned(args[7]).mkdir(exist_ok=True); owned(args[7]).chmod(0o700); raise SystemExit(0)
    if len(args)!=8 or args[:6]!=['-o','root','-g','root','-m','0644']: refuse()
    if args[7] not in [str(root/'etc/caddy/sites/20-commonswarm-mcp.caddy'),str(root/'etc/caddy/sites/10-commonswarm-api.caddy')]: refuse()
    shutil.copyfile(owned(args[6]),owned(args[7])); owned(args[7]).chmod(0o644)
elif name=='readlink':
    if len(args)!=2 or args[0]!='-f': refuse()
    print(os.path.realpath(owned(args[1])))
elif name=='cat':
    if len(args)!=1: refuse()
    sys.stdout.write(owned(args[0]).read_text())
elif name=='stat':
    if len(args)!=3 or args[:2]!=['-c','%a %u %g']: refuse()
    p=owned(args[2]); print(oct(p.stat().st_mode & 0o777)[2:]+' 0 0')
elif name=='dirname':
    if len(args)!=1: refuse()
    print(os.path.dirname(args[0]))
else: refuse()
`;

// The archive keeper's helper for the fixture: INSTALL section 4 runs its check verb (the keeper refuses a
// non-/tmp binding, KEEPER:113-115).
const keeperHelper = (root: string) => `#!/usr/bin/python3
import json,sys
assert sys.argv[1:]==['check'], 'fixture keeper: check only'
r=json.load(open(${JSON.stringify(join(root, 'admin-release/recycle.json'))}))
assert r['archive'].startswith(${JSON.stringify(join(root, 'tmp/admin-issuance-'))}), 'REFUSED: binding is not a /tmp archive'
print('PASS keeper check')
`;
const keeperFiles = (root: string): Array<[string, string, number, string]> => [
  ['commonswarm-recycle-archive', 'libexec/commonswarm-recycle-archive', 0o700, keeperHelper(root)],
  ['commonswarm-recycle-archive-keep.service', 'systemd/commonswarm-recycle-archive-keep.service', 0o644, '[Unit]\nDescription=fixture keep\n[Service]\nType=oneshot\nExecStart=/usr/local/libexec/commonswarm-recycle-archive keep\n'],
  ['commonswarm-recycle-archive-keep.timer', 'systemd/commonswarm-recycle-archive-keep.timer', 0o644, '[Timer]\nOnCalendar=*-*-* 03,09,15,21:40:00 UTC\n[Install]\nWantedBy=timers.target\n'],
  ['commonswarm-recycle-archive-restore.service', 'systemd/commonswarm-recycle-archive-restore.service', 0o644, '[Unit]\nDescription=fixture restore\n[Service]\nType=oneshot\nExecStart=/usr/local/libexec/commonswarm-recycle-archive restore\n[Install]\nWantedBy=multi-user.target\n'],
  ['commonswarm-recycle-archive.conf', 'tmpfiles.d/commonswarm-recycle-archive.conf', 0o600, 'x /tmp/admin-issuance-*.tar - - - - -\n'],
];

// A synthetic INSTALL.md with the reviewed line structure. The four pinned ranges hold fixture excerpts;
// every other line is a trap that records and fails loudly if it ever runs (sections 1-3 and the rest).
const INSTALL_LINES = 616;
const ranges = { shell_options: [41, 42], bundle: [57, 61], quiet: [63, 75], section4: [516, 599] } as const;
function section4(root: string) {
  const p = (path: string) => path.replace('/usr/local/libexec', join(root, 'libexec')).replace('/etc/systemd/system', join(root, 'systemd'))
    .replace('/etc/tmpfiles.d', join(root, 'tmpfiles.d')).replace('/var/lib/commonswarm-admin-release', join(root, 'var-lib-admin-release'))
    .replace('/etc/commonswarm-admin-release', join(root, 'admin-release'));
  const removal = ['/etc/systemd/system/commonswarm-recycle-archive-keep.timer', '/etc/systemd/system/commonswarm-recycle-archive-keep.service',
    '/etc/systemd/system/commonswarm-recycle-archive-restore.service', '/usr/local/libexec/commonswarm-recycle-archive', '/etc/tmpfiles.d/commonswarm-recycle-archive.conf'].map(p);
  const links = keeperLinks.map(l => join(root, 'systemd', l));
  const baselineFiles = ['/etc/commonswarm-admin-release/recycle.json', '/usr/local/libexec/commonswarm-admin-edge-recycle', '/etc/systemd/system/commonswarm-edge-recycle.service.d/50-admin-measurement.conf'].map(p);
  const files = keeperFiles(root).map(([source, target, mode]) => ` (${JSON.stringify(source)}, ${JSON.stringify(join(root, target))}, 0o${mode.toString(8)}),`);
  const lines = [
    'archive_keeper_quiet',
    'test "$(hostname)" = "$ARCHIVE_KEEPER_HOST"',
    'test "$(systemctl show --value -p ActiveState commonswarm-edge-recycle.service)" = inactive',
    `${p('/usr/local/libexec/commonswarm-recycle-archive')} check`,
    "python3 - <<'PY'",
    'import os, pathlib, stat',
    "b = pathlib.Path(os.environ['ARCHIVE_KEEPER_BUNDLE'])",
    'files = [',
    ...files,
    ']',
    'for source, target, mode in files:',
    '    p = pathlib.Path(target)',
    '    st = p.lstat()',
    '    assert stat.S_ISREG(st.st_mode) and st.st_uid == st.st_gid == 0',
    '    assert stat.S_IMODE(st.st_mode) == mode and st.st_nlink == 1',
    "    assert p.read_bytes() == (b/source).read_bytes(), 'STOP: removal bytes differ'",
    "print('PASS every removal path, metadata and reviewed bytes')",
    'PY',
    'systemctl disable --now commonswarm-recycle-archive-keep.timer \\',
    '  commonswarm-recycle-archive-keep.service commonswarm-recycle-archive-restore.service',
    'test "$(systemctl show --value -p ActiveState commonswarm-recycle-archive-keep.service)" = inactive',
    'test "$(systemctl show --value -p ActiveState commonswarm-recycle-archive-restore.service)" = inactive',
    'ARCHIVE_KEEPER_LEDGER_BEFORE=absent',
    `if test -e ${p('/var/lib/commonswarm-admin-release')}/archives.json || test -L ${p('/var/lib/commonswarm-admin-release')}/archives.json; then`,
    `  ARCHIVE_KEEPER_LEDGER_BEFORE=$(sha256sum ${p('/var/lib/commonswarm-admin-release')}/archives.json)`,
    'fi',
    'ARCHIVE_KEEPER_ARCHIVES_BEFORE=absent',
    `if test -e ${p('/var/lib/commonswarm-admin-release')}/archives || test -L ${p('/var/lib/commonswarm-admin-release')}/archives; then`,
    `  test -d ${p('/var/lib/commonswarm-admin-release')}/archives`,
    `  test ! -L ${p('/var/lib/commonswarm-admin-release')}/archives`,
    '  ARCHIVE_KEEPER_ARCHIVES_BEFORE=present',
    'fi',
    'command -v rm',
    'for p in \\',
    ...removal.map(r => `  ${r} \\`).slice(0, -1), `  ${removal[removal.length - 1]}; do`,
    '  test -f "$p"',
    '  test ! -L "$p"',
    `  rm -- "$p" || { printf 'STOP removal refused: %s; retain remaining files and report guard message\\n' "$p" >&2; exit 1; }`,
    'done',
    'systemctl daemon-reload',
    'for p in \\',
    ...[...removal, ...links].map(r => `  ${r} \\`).slice(0, -1), `  ${links[links.length - 1]}; do`,
    '  test ! -e "$p"',
    '  test ! -L "$p"',
    'done',
    'for u in commonswarm-recycle-archive-keep.timer commonswarm-recycle-archive-keep.service commonswarm-recycle-archive-restore.service; do',
    '  test "$(systemctl show --value -p LoadState "$u")" = not-found',
    '  if systemctl is-active --quiet "$u"; then exit 1; fi',
    'done',
    'if test "$ARCHIVE_KEEPER_LEDGER_BEFORE" = absent; then',
    `  test ! -e ${p('/var/lib/commonswarm-admin-release')}/archives.json`,
    `  test ! -L ${p('/var/lib/commonswarm-admin-release')}/archives.json`,
    'else',
    `  test "$(sha256sum ${p('/var/lib/commonswarm-admin-release')}/archives.json)" = "$ARCHIVE_KEEPER_LEDGER_BEFORE"`,
    'fi',
    'if test "$ARCHIVE_KEEPER_ARCHIVES_BEFORE" = absent; then',
    `  test ! -e ${p('/var/lib/commonswarm-admin-release')}/archives`,
    `  test ! -L ${p('/var/lib/commonswarm-admin-release')}/archives`,
    'else',
    `  test -d ${p('/var/lib/commonswarm-admin-release')}/archives`,
    `  test ! -L ${p('/var/lib/commonswarm-admin-release')}/archives`,
    'fi',
    'test "$(sha256sum \\',
    ...baselineFiles.slice(0, -1).map(b => `  ${b} \\`), `  ${baselineFiles[2]})" = "$ARCHIVE_KEEPER_BASELINE"`,
    'systemctl is-enabled commonswarm-edge-recycle.timer',
    'systemctl is-active commonswarm-edge-recycle.timer',
    "printf 'PASS rollback: five installed files and three enable links absent; durable state retained\\n'",
  ];
  assert.equal(lines.length, 84, 'section 4 keeps the reviewed 84-line span');
  return lines;
}
function installMd(root: string, bundle: string) {
  const out = Array.from({ length: INSTALL_LINES }, (_, i) => `printf 'TRAP INSTALL line ${i + 1}\\n' >>${join(root, 'trap.log')}; exit 97`);
  const put = (start: number, body: string[]) => body.forEach((line, i) => { out[start - 1 + i] = line; });
  put(41, ['set -euo pipefail', 'umask 077']);
  put(57, [`export ARCHIVE_KEEPER_BUNDLE=${bundle}`, 'test -d "$ARCHIVE_KEEPER_BUNDLE"', 'test ! -L "$ARCHIVE_KEEPER_BUNDLE"', 'cd "$ARCHIVE_KEEPER_BUNDLE"', 'sha256sum -c SHA256SUMS']);
  put(63, ['archive_keeper_quiet() {', "  python3 - <<'PY'", 'import datetime', 'n = datetime.datetime.now(datetime.timezone.utc)',
    'day = n.replace(hour=0, minute=0, second=0, microsecond=0)', 'slots = [day + datetime.timedelta(days=d, hours=h, minutes=30)',
    '         for d in (-1, 0, 1) for h in (3, 9, 15, 21)]', 'distance = min(abs((n-s).total_seconds()) for s in slots)',
    'if distance <= 900:', "    raise SystemExit('STOP: within 15 minutes of a recycle slot')", "print('PASS quiet slot; seconds to nearest slot:', int(distance))", 'PY', '}']);
  put(516, section4(root));
  return out.join('\n') + '\n';
}
const excerpt = (text: string, [start, end]: readonly [number, number]) => text.split('\n').slice(start - 1, end).map(l => l + '\n').join('');
function excerptPins(text: string) {
  return Object.fromEntries(Object.entries(ranges).map(([key, span]) => [key, { lines: [...span], sha256: hash(excerpt(text, span)) }]));
}

type Fixture = ReturnType<typeof fixture>;
type Entry = { type: string; mode: number; sha256?: string; target?: string };
function fixture(config: Record<string, unknown> = {}, options: { mode?: string; keeper?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(scratch, 'case-')));
  const mode = options.mode ?? 'upgrade-existing', keeper = options.keeper ?? mode !== 'fresh';
  const put = (path: string, value: string | Buffer | object, fileMode = 0o600) => {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: fileMode }); chmodSync(target, fileMode);
  };
  const dir = (path: string, dirMode = 0o700) => { mkdirSync(join(root, path), { recursive: true, mode: dirMode }); chmodSync(join(root, path), dirMode); };
  for (const d of ['bin', 'stage', 'proof', 'tmp', 'mac-tmp', 'edge/releases', 'admin-issuance/releases', 'etc/caddy/sites', 'box', 'inputs', 'var-lib-release']) dir(d);
  dir('libexec', 0o755); dir('systemd', 0o755); dir('tmpfiles.d', 0o755);
  put('bin/_dispatch', dispatcher, 0o700);
  for (const name of ['python3', 'systemctl', 'ai_db', 'ai_ro', 'docker', 'date', 'hostname', 'sha256sum', 'rm', 'rmdir', 'awk', 'mkdir', 'cp', 'chmod',
    'caddy', 'ai_deadline', 'ai_run', 'cmp', 'ln', 'mv', 'timeout', 'install', 'readlink', 'cat', 'stat', 'dirname', 'node', 'ssh', 'scp', 'curl', 'git', 'sudo',
    'logger', 'mktemp', 'shasum'])
    symlinkSync('_dispatch', join(root, 'bin', name));
  // Release R: helper tree (ai-open's RELEASE_ROOT), its upload and the reviewed migrations the W4 measurement hashes.
  const release = `admin-issuance/releases/${sha}`;
  const tracked: Record<string, string> = {
    'src/reviewed.txt': 'reviewed tracked bytes at R\n', 'scripts/live-ordinary-controls.mjs': producerSource,
    'deploy/edge-runtime/compose.yaml': 'services: {}\n', 'deploy/edge-runtime/compose.override.yaml': 'reviewed override\n',
    'docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md': plan,
  };
  for (const version of ['20261001000001', '20261001000002', '20261001000003', '20261001000004', '20261001000005', '20260928000003', '20261002000001',
    '20261003000001', '20261003000002', '20261003000003', '20261003000004', '20261003000005']) tracked[`supabase/migrations/${version}_fixture.sql`] = '-- reviewed migration fixture\n';
  for (const [path, bytes] of Object.entries(tracked)) put(`${release}/${path}`, bytes, 0o644);
  put(`${release}/RELEASE_SHA`, sha + '\n', 0o644);
  const upload = `tmp/admin-issuance-${sha}-${wid}.tar`;
  const archived = spawnSync('/usr/bin/python3', ['-c', 'import json,sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t:\n    for name in json.loads(sys.argv[3]): t.add(sys.argv[2]+"/"+name,arcname=name)',
    join(root, upload), join(root, release), JSON.stringify(Object.keys(tracked).sort())], { encoding: 'utf8' });
  assert.equal(archived.status, 0, archived.stderr); chmodSync(join(root, upload), 0o600);
  const archiveSha = hash(readFileSync(join(root, upload)));
  // Baseline edge release and helper tree (the measured first-pass state), current -> baseline.
  for (const [path, bytes] of Object.entries({ RELEASE_SHA: baseline + '\n', 'deploy/edge-runtime/compose.yaml': 'services: {}\n',
    'deploy/edge-runtime/compose.override.yaml': 'reviewed override\n', 'src/reviewed.txt': 'baseline tracked bytes\n' })) put(`edge/releases/${baseline}/${path}`, bytes, 0o644);
  symlinkSync(join(root, 'edge/releases', baseline), join(root, 'edge/current'));
  put(`admin-issuance/releases/${baseline}/RELEASE_SHA`, baseline + '\n', 0o644);
  put(`admin-issuance/releases/${baseline}/deploy/supabase-stack/migrate/make-pg-service.mjs`, '// helper\n', 0o644);
  // Legacy /tmp binding, first-pass hook, drop-in and intent.
  const legacy = `tmp/admin-issuance-${baseline}-${legacyWid}.tar`;
  const legacyTar = spawnSync('/usr/bin/python3', ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t:\n    for name in ["deploy/edge-runtime/compose.yaml","deploy/edge-runtime/compose.override.yaml","src/reviewed.txt"]: t.add(sys.argv[2]+"/"+name,arcname=name)',
    join(root, legacy), join(root, 'edge/releases', baseline)], { encoding: 'utf8' });
  assert.equal(legacyTar.status, 0, legacyTar.stderr); chmodSync(join(root, legacy), 0o600);
  const legacyBytes = readFileSync(join(root, legacy)), legacyHash = hash(legacyBytes);
  dir('admin-release', 0o700);
  const binding = { release_sha: baseline, target: join(root, 'edge/releases', baseline), image_digest: edgeImage, artifact_digest: legacyHash,
    archive: join(root, legacy), postgres_image: postgresImage, release_root: join(root, 'admin-issuance/releases', baseline) };
  if (mode !== 'fresh') {
    put('admin-release/recycle.json', JSON.stringify(binding, null, 0) + '\n', 0o600);
    put('admin-release/recycle-intent.json', '{"reopen": false, "generation": 7}\n', 0o600);
    put('libexec/commonswarm-admin-edge-recycle', mode === 'accept-existing' ? candidateHook : legacyHook, 0o700);
    dir(`systemd/${service}.d`, 0o755);
    put(`systemd/${service}.d/50-admin-measurement.conf`, reviewedDropin(root), 0o644);
  }
  put(`systemd/${service}`, '[Service]\nType=oneshot\nExecStart=/usr/bin/docker restart commonswarm-edge-edge-runtime-1\n', 0o644);
  put(`systemd/${timer}`, '[Timer]\nOnCalendar=*-*-* 03,09,15,21:30:00 UTC\n[Install]\nWantedBy=timers.target\n', 0o644);
  // The keeper as installed: five files, three enable links, its bundle, its durable state and the U10 vars.
  if (keeper) {
    for (const [, target, fileMode, bytes] of keeperFiles(root)) put(target, bytes, fileMode);
    for (const link of keeperLinks) { mkdirSync(dirname(join(root, 'systemd', link)), { recursive: true, mode: 0o755 }); symlinkSync(join(root, 'systemd', link.split('/')[1]!), join(root, 'systemd', link)); }
    dir('var-lib-admin-release', 0o700); dir('var-lib-admin-release/archives', 0o700);
    put(`var-lib-admin-release/archives/${baseline}-${legacyWid}.tar`, legacyBytes, 0o600);
    put('var-lib-admin-release/archives.json', JSON.stringify([{ name: `${baseline}-${legacyWid}.tar`, sha256: legacyHash,
      source: `/tmp/admin-issuance-${baseline}-${legacyWid}.tar`, time: '2026-10-10T16:52:00Z', uid: 1001, gid: 1001, mode: 0o600 }], null, 2) + '\n', 0o600);
    put('var-lib-admin-release/source-metadata.json', '{}\n', 0o600);
  }
  dir('keeper-bundle', 0o700);
  for (const [source, , fileMode, bytes] of keeperFiles(root)) put(`keeper-bundle/${source}`, bytes, fileMode);
  put('keeper-bundle/SHA256SUMS', keeperFiles(root).map(([source, , , bytes]) => `${hash(bytes)}  ${source}`).join('\n') + '\n', 0o600);
  const install = installMd(root, join(root, 'keeper-bundle'));
  const installUpload = `tmp/admin-issuance-${sha}-${wid}-keeper-INSTALL.md`;
  if (keeper) put(installUpload, install, 0o600);
  const keeperBaseline = () => ['admin-release/recycle.json', 'libexec/commonswarm-admin-edge-recycle', `systemd/${service}.d/50-admin-measurement.conf`]
    .map(rel => `${hash(readFileSync(join(root, rel)))}  ${join(root, rel)}`).join('\n');
  if (keeper) put(`root/${varsName}`, `declare -x ARCHIVE_KEEPER_BASELINE="${keeperBaseline()}"\ndeclare -x ARCHIVE_KEEPER_HOST="yulan-vps-1"\ndeclare -x ARCHIVE_KEEPER_UPLOAD_OWNER="ops"\ndeclare -- ARCHIVE_KEEPER_SOURCE_METADATA="secret-free fixture"\n`, 0o600);
  put('keeper-install-REPORT.md', 'fixture HezLead keeper install receipt\n', 0o600);
  // Caddy, environment and live receipts that the W4 blocks validate.
  const caddyfile = '{\n\tauto_https off\n}\nimport sites/*.caddy\n';
  put('etc/caddy/Caddyfile', caddyfile, 0o644);
  for (const [file, bytes] of [['20-commonswarm-mcp.caddy', 'mcp.commonswarm.com {\nimport mcp_oauth_active\nimport mcp_resource_active\nrequest>headers>Authorization delete\nresp_headers>Authorization delete\n}\n'],
    ['10-commonswarm-api.caddy', 'api.commonswarm.com {\n\t@edge_functions path /functions/v1 /functions/v1/*\nrequest>headers>Authorization delete\nresp_headers>Authorization delete\n}\n']] as const) {
    put(`etc/caddy/sites/${file}`, bytes, 0o644); put(`stage/${file.startsWith('20') ? 'mcp' : 'api'}.caddy`, bytes, 0o600);
  }
  put('stage/edge.env', 'SWARM_MCP_PUBLIC_ENABLED=1\n'); put('box/.env', 'SWARM_MCP_PUBLIC_ENABLED=1\n');
  const consent = JSON.stringify(consentReceipt());
  put('proof/consent-pre-W1.json', consent); put('proof/ordinary-before.json', liveReceipt('before', consent, baseline));
  put('proof/ordinary-recovery.json', liveReceipt('recovery', consent, baseline)); put('proof/ordinary-after.json', liveReceipt('after', consent, sha));
  // External state models: systemd units, the edge container and the cutover singleton.
  const units: Record<string, unknown> = { [timer]: { load: 'loaded', active: 'active', enabled: 'enabled' }, [service]: { load: 'loaded', active: 'inactive', enabled: 'static' } };
  if (keeper) Object.assign(units, { [keeperUnits[0]!]: { load: 'loaded', active: 'active', enabled: 'enabled' },
    [keeperUnits[1]!]: { load: 'loaded', active: 'inactive', enabled: 'enabled' }, [keeperUnits[2]!]: { load: 'loaded', active: 'inactive', enabled: 'enabled' } });
  put('units.json', units);
  put('docker.json', { working_dir: join(root, 'edge/releases', baseline, 'deploy/edge-runtime') });
  put('cutover.json', { enabled: false, invalidated: true, generation: 11, measured_generation: 10, measured: baseline, approved: baseline });
  put('fixture.json', { sha, image: edgeImage, ...config });
  put('commands.jsonl', '');
  const inputs: Record<string, unknown> = {
    release_sha: sha, plan_sha256: hash(planBytes), archive_sha256: archiveSha, window: 'W4', window_id: wid, window_end_utc: '2026-10-10T12:20:00Z',
    baseline_edge_sha: baseline, baseline_edge_image: edgeImage, baseline_postgres_image: postgresImage,
    baseline_mcp_caddy_sha256: hash(readFileSync(join(root, 'etc/caddy/sites/20-commonswarm-mcp.caddy'))),
    baseline_api_caddy_sha256: hash(readFileSync(join(root, 'etc/caddy/sites/10-commonswarm-api.caddy'))), baseline_caddyfile_sha256: hash(caddyfile),
    edge_recycle_service: service, edge_recycle_timer: timer, edge_recycle_sha256: '',
    recycle_install_mode: mode, recycle_baseline_sha256: '',
    keeper_install_receipt_sha256: keeper ? hash(readFileSync(join(root, 'keeper-install-REPORT.md'))) : null,
    keeper_host: keeper ? 'yulan-vps-1' : null, keeper_upload_owner: keeper ? 'ops' : null, keeper_baseline: keeper ? keeperBaseline() : null,
    keeper_install_vars_path: keeper ? join(root, 'root', varsName) : null, keeper_install_md_sha256: keeper ? hash(install) : null,
    keeper_install_excerpts: keeper ? excerptPins(install) : null,
  };
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    PATH: join(root, 'bin'), PYTHONDONTWRITEBYTECODE: '1', W4B_ROOT: root,
    INPUTS_FILE: join(root, 'inputs.json'), PLAN_FILE: planPath, PROOF_DIR: join(root, 'proof'), SECRET_STAGE: join(root, 'stage'),
    NEW_EDGE: join(root, 'edge/releases', sha), OLD_EDGE: join(root, 'edge/releases', baseline),
    RELEASE_ROOT: join(root, release), RELEASE_SHA: sha, WINDOW: 'W4', WINDOW_ID: wid, BOX_ARCHIVE_PATH: join(root, upload),
    EDGE_RECYCLE_SERVICE: service, EDGE_RECYCLE_TIMER: timer, RECYCLE_BASELINE_FILE: join(root, 'inputs/recycle-baseline.json'),
    LIVE_CONTROLS_FILE: join(root, 'proof/ordinary-before.json'), CONSENT_RECEIPT_FILE: join(root, 'proof/consent-pre-W1.json'), ...extra,
  });
  // One pass, longest name first, so a replacement is never remapped again.
  const remapPattern = new RegExp([...remaps].sort((a, b) => b[0].length - a[0].length).map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  function remap(source: string) {
    return source.replace(remapPattern, from => join(root, remaps.find(([name]) => name === from)![1]));
  }
  // The A1 baseline receipt: HezLead's U10-bound measurement of this box, computed here independently of the plan.
  function metadata(rel: string) {
    const path = join(root, rel);
    if (!existsSync(path) && !isLink(path)) return { path, present: false, sha256: null, uid: null, gid: null, mode: null };
    const st = lstatSync(path);
    return { path, present: true, sha256: st.isFile() ? hash(readFileSync(path)) : null, uid: 0, gid: 0, mode: (st.mode & 0o7777).toString(8).padStart(4, '0') };
  }
  function receipt() {
    const cat = (unit: string) => spawnSync(join(root, 'bin/systemctl'), ['cat', unit], { encoding: 'utf8', env: env() }).stdout.replace(/\n+$/, '') + '\n';
    const entries = (rel: string) => existsSync(join(root, rel)) ? readdirSync(join(root, rel)).sort() : null;
    const dirMeta = (rel: string) => { const m = metadata(rel); return { path: m.path, present: m.present, uid: m.uid, gid: m.gid, mode: m.mode, entries: entries(rel) }; };
    return {
      kind: 'c1-w4-recycle-baseline', release_sha: sha, window: 'W4', window_id: wid, plan_sha256: hash(planBytes), mode,
      hook: metadata('libexec/commonswarm-admin-edge-recycle'), config: metadata('admin-release/recycle.json'),
      dropin: metadata(`systemd/${service}.d/50-admin-measurement.conf`), intent: metadata('admin-release/recycle-intent.json'),
      config_dir: dirMeta('admin-release'), dropin_dir: dirMeta(`systemd/${service}.d`),
      service: { unit: service, sha256: hash(cat(service)), active_state: 'inactive' }, timer: { unit: timer, sha256: hash(cat(timer)), active_state: 'active', enabled: 'enabled' },
      archive: mode === 'fresh' ? null : { path: join(root, legacy), sha256: legacyHash, uid: 0, gid: 0, mode: '0600' },
      helper: mode === 'fresh' ? null : { release_sha: baseline, path: join(root, 'admin-issuance/releases', baseline) },
      edge: { release_sha: baseline, image: edgeImage },
      keeper: keeper ? {
        install_receipt_sha256: inputs.keeper_install_receipt_sha256, host: 'yulan-vps-1', baseline: keeperBaseline(),
        files: Object.fromEntries(keeperFiles(root).map(([, target, fileMode, bytes]) => [join(root, target), { sha256: hash(bytes), uid: 0, gid: 0, mode: fileMode.toString(8).padStart(4, '0') }])),
        links: Object.fromEntries(keeperLinks.map(link => [join(root, 'systemd', link), readlinkSync(join(root, 'systemd', link))])),
        state: { path: join(root, 'var-lib-admin-release'), mode: '0700', archives_mode: '0700', ledger_sha256: hash(readFileSync(join(root, 'var-lib-admin-release/archives.json'))),
          archives: { [`${baseline}-${legacyWid}.tar`]: legacyHash } },
      } : null,
      expected: { hook_sha256: hash(candidateHook), dropin_sha256: hash(reviewedDropin(root)), archive: join(root, 'var-lib-admin-release/archives', `${sha}-${wid}.tar`),
        binding_sha256: hash(JSON.stringify(Object.fromEntries(Object.entries({ ...binding, release_sha: sha, target: join(root, 'edge/releases', sha), artifact_digest: archiveSha,
          archive: join(root, 'var-lib-admin-release/archives', `${sha}-${wid}.tar`), release_root: join(root, release) }).sort(([a], [b]) => a < b ? -1 : 1))).replace(/,"/g, ', "').replace(/":/g, '": ') + '\n') },
      approval: mode === 'upgrade-existing' ? { approver: 'HezLead', action: 'upgrade-recycle-hook', release_sha: sha, window_id: wid, plan_sha256: hash(planBytes),
        old_hook_sha256: hash(legacyHook), new_hook_sha256: hash(candidateHook), prompt_ref: 'hezlead/u10-fixture' } : null,
    };
  }
  function writeInputs(change: Record<string, unknown> = {}, receiptChange: (r: any) => void = () => {}) {
    const r = receipt(); receiptChange(r);
    const text = JSON.stringify(r);
    put('inputs/recycle-baseline.json', text);
    inputs.edge_recycle_sha256 = (r.service as { sha256: string }).sha256; inputs.recycle_baseline_sha256 = hash(text);
    put('inputs.json', { ...inputs, ...change });
  }
  writeInputs();
  const blockFiles = ['ai-timer-guard', 'ai-w4-timer-recovery', 'ai-release-aside', 'ai-recycle-install', 'ai-recycle-rollback', 'ai-w4-state'];
  for (const name of blockFiles) if (has(name)) put(`blocks/${name}.sh`, remap(block(name)));
  // The window shell's ai_run evaluates the verified block in place; the stub records the call and may fail it.
  // W4B_FAULT=F3 is the staging driver's fault right after ai-recycle-install completes (outside the plan).
  const shim = `ai_run() {
 case "$1" in
  ${blockFiles.join('|')})
   command ai_run "$@" || return $?
   eval "$(cat "$W4B_ROOT/blocks/$1.sh")"
   if test "$1" = ai-recycle-install && test "\${RECYCLE_INSTALL_ACTION:-install}" = install && test "\${W4B_FAULT:-}" = F3; then printf 'DRIVER FAULT F3 after ai-recycle-install completed\\n' >&2; return 1; fi;;
  *) command ai_run "$@";;
 esac
}`;
  function run(steps: string[], extra: Record<string, string> = {}) {
    const source = steps.map(step => step.startsWith('#') ? step : remap(block(step))).join('\n');
    const result = spawnSync('/bin/bash', [], { input: 'set -euo pipefail\n' + shim + '\n' + source + '\n', encoding: 'utf8', timeout: 60_000, cwd: root, env: env(extra) });
    assert.ifError(result.error); assert.equal(result.signal, null, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /UNMODELLED/);
    if (result.status === 0) assert.doesNotMatch(result.stderr, /unbound variable|parameter (?:null or not set|not set)/, 'Bash 3.2 must not mask a missing input');
    return { ...result, calls: lines('commands.jsonl') };
  }
  function lines(path: string): any[] { return readFileSync(join(root, path), 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)); }
  return { root, put, run, remap, legacyBytes, legacyHash, inputs, writeInputs, receipt, install, installUpload, upload, legacy, release, archiveSha, binding, keeper, mode,
    json: (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8')), fixtureConfig: (change: Record<string, unknown>) => put('fixture.json', { ...JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8')), ...change }) };
}
function isLink(path: string) { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }

// The monitored roots of the exact-restoration sets, measured by the test itself (independent of the plan's code).
function monitored(f: Fixture) {
  const out = new Map<string, Entry>();
  const walk = (rel: string) => {
    const path = join(f.root, rel);
    let st; try { st = lstatSync(path); } catch { return; }
    if (st.isSymbolicLink()) out.set(rel, { type: 'link', mode: st.mode & 0o7777, target: readlinkSync(path) });
    else if (st.isDirectory()) { out.set(rel, { type: 'dir', mode: st.mode & 0o7777 }); for (const name of readdirSync(path).sort()) walk(join(rel, name)); }
    else out.set(rel, { type: 'file', mode: st.mode & 0o7777, sha256: hash(readFileSync(path)) });
  };
  for (const rel of ['admin-release', 'libexec', 'systemd', 'tmpfiles.d', 'etc/caddy', 'edge/current', 'edge/releases', 'edge/failed-attempts',
    'admin-issuance/releases', 'var-lib-admin-release']) walk(rel);
  for (const name of readdirSync(join(f.root, 'tmp')).filter(n => /^admin-issuance-/.test(n)).sort()) walk(join('tmp', name));
  return out;
}
const keeperPaths = [...keeperFiles('/x').map(([, target]) => target), ...keeperLinks.map(l => `systemd/${l}`)];
// §3: RESTORED objects equal the snapshot; RETAINED window residue is listed; RETIRED keeper objects are absent.
function exactRestoration(f: Fixture, before: Map<string, Entry>, after: Map<string, Entry>, { retired, promoted }: { retired: boolean; promoted: boolean }) {
  const residue = (rel: string) => rel === 'edge/failed-attempts' || rel.startsWith(`edge/failed-attempts/${sha}-W4-${wid}`)
    || rel.startsWith(`${f.release}`) || rel === f.upload || rel === f.installUpload
    || (promoted && rel === `var-lib-admin-release/archives/${sha}-${wid}.tar`)
    // A fresh install creates the durable state directories; they stay with the promoted archive (RETAINED).
    || (promoted && ['var-lib-admin-release', 'var-lib-admin-release/archives'].includes(rel) && !before.has(rel));
  const problems: string[] = [];
  for (const rel of new Set([...before.keys(), ...after.keys()])) {
    if (residue(rel)) continue;
    if (retired && keeperPaths.includes(rel)) { if (after.has(rel)) problems.push(`RETIRED ${rel} expected absent got present`); continue; }
    const b = before.get(rel), a = after.get(rel);
    if (JSON.stringify(b) !== JSON.stringify(a)) problems.push(`RESTORED ${rel} expected ${JSON.stringify(b ?? 'absent')} got ${JSON.stringify(a ?? 'absent')}`);
  }
  if (promoted) assert.equal(hash(readFileSync(join(f.root, `var-lib-admin-release/archives/${sha}-${wid}.tar`))), f.archiveSha, 'RETAINED promoted R archive holds the verified upload bytes');
  assert.deepEqual(problems, [], 'exact restoration sets (§3)');
}

const forward = () => ['ai-w4-preflight', 'ai-w4-caddy-candidate', ...(has('ai-w4-keeper-retire') ? ['ai-w4-keeper-retire'] : []), 'ai-w4-apply'];
const phrase = 'keeper retired; re-install required before reboot';
function units(f: Fixture) { return f.json('units.json'); }
function cutover(f: Fixture) { return f.json('cutover.json'); }

for (const fault of ['F1', 'F2', 'F3'] as const) test(`${fault} / w4-second-pass-exact-restoration: a fault at ${fault} rolls back to the exact pre-attempt sets; the keeper stays retired`, () => {
  {
    const f = fixture();
    const faults: Record<string, Record<string, unknown>> = {
      F1: { fail_calls: [['ln', '-sfT', join(f.root, 'edge/releases', sha), join(f.root, 'edge/current.admin-issuance')]] },
      F2: { fail_calls: [['python3', '-', join(f.root, 'edge/releases', sha), join(f.root, 'inputs.json'), join(f.root, 'proof/edge-measurement.json')]] },
      F3: {},
    };
    f.fixtureConfig(faults[fault]!);
    const before = monitored(f), generation = cutover(f).generation;
    const run = f.run(forward(), { W4B_FAULT: fault });
    assert.notEqual(run.status, 0, `${fault} stops the forward order`);
    const calls = run.calls.map(c => c.join(' '));
    if (fault === 'F1') assert.ok(calls.some(c => c.startsWith('ln -sfT')) && !calls.some(c => c.startsWith('mv -Tf')), `F1 stops at the switch: ${run.stderr}`);
    if (fault === 'F2') assert.ok(calls.some(c => c.startsWith('docker compose') && c.includes(' up ')) && !existsSync(join(f.root, 'proof/edge-measurement.json')), `F2 stops after the recreate: ${run.stderr}`);
    if (fault === 'F3') assert.match(run.stderr, /DRIVER FAULT F3 after ai-recycle-install completed/, `F3 stops right after the completed upgrade: ${run.stderr}`);
    assert.equal(units(f)[timer].active, 'active', `${fault}: the apply EXIT guard re-armed the timer`);
    const rollback = f.run(['ai-w4-rollback']);
    assert.equal(rollback.status, 0, `${fault} rollback: ${rollback.stderr}`);
    const close = f.run(['ai-close'], { CLOSE_RESULT: 'recovered', LIVE_CONTROLS_FILE: join(f.root, 'proof/ordinary-recovery.json') });
    assert.equal(close.status, 0, `${fault} recovered close: ${close.stderr}`);
    exactRestoration(f, before, monitored(f), { retired: true, promoted: fault === 'F3' });
    assert.equal(units(f)[timer].active, 'active');
    const db = cutover(f);
    assert.equal(db.measured, baseline); assert.equal(db.measured_generation, db.generation);
    assert.equal(db.identities.artifact_digest, f.legacyHash);
    assert.ok(!db.enabled && db.invalidated && db.generation > generation, `${fault}: issuance CLOSED at a higher generation ${JSON.stringify(db)}`);
    assert.ok(close.stdout.includes(phrase), `${fault}: recovered close output carries the ruling-11 phrase`);
    assert.ok(readFileSync(join(f.root, 'proof/W4-recovered-close.txt'), 'utf8').includes(phrase), `${fault}: close record carries the ruling-11 phrase`);
    assert.ok(!existsSync(join(f.root, 'trap.log')), `${fault}: no INSTALL section 1-3 line ran (no automatic re-install)`);
  }
});

test('F-control / w4-second-pass-success: the same fixture without a fault reaches a success close', () => {
  const f = fixture();
  const run = f.run([...forward(), 'ai-w4-readback']);
  assert.equal(run.status, 0, `forward order without a fault: ${run.stderr}`);
  const close = f.run(['ai-close'], { CLOSE_RESULT: 'success', LIVE_CONTROLS_FILE: join(f.root, 'proof/ordinary-after.json') });
  assert.equal(close.status, 0, `success close: ${close.stderr}`);
  assert.equal(f.json('proof/close-result.json').result, 'success');
});

// ---- Shared helpers for single-step checks ----
function entryOf(f: Fixture, rel: string) {
  const path = join(f.root, rel);
  let st; try { st = lstatSync(path); } catch { return null; }
  return st.isSymbolicLink() ? { link: readlinkSync(path) } : st.isFile() ? { mode: st.mode & 0o7777, sha256: hash(readFileSync(path)) } : { dir: st.mode & 0o7777 };
}
const keeperState = (f: Fixture) => Object.fromEntries(keeperPaths.map(p => [p, entryOf(f, p)]));
const proofHas = (f: Fixture, name: string) => existsSync(join(f.root, 'proof', name));
function prepared(f: Fixture) {
  const r = f.run(['ai-w4-preflight', 'ai-w4-caddy-candidate']);
  assert.equal(r.status, 0, `preflight and Caddy candidate: ${r.stderr}`);
  return r;
}
function refused(r: { status: number | null; stderr: string }, text: string) {
  assert.notEqual(r.status, 0, 'must refuse'); assert.ok(r.stderr.includes(text), `expected ${text}; observed ${JSON.stringify(r.stderr)}`);
}
const quietRan = (r: { calls: any[] }) => r.calls.some(c => c.length === 2 && c[0] === 'python3' && c[1] === '-');

test('H1(d)(a,i) / keeper-retire-adopts-and-retires: valid inputs reach section 4 and retire the keeper; no trap line runs', () => {
  assert.ok(block('ai-w4-keeper-retire').includes("HezLead ruling 12 (2026-10-10): ruling 1 overrides INSTALL.md's 'no open release window' prose, for W4 only"), '(i) the exact ruling-12 citation');
  assert.ok(!block('ai-w4-keeper-retire').includes('section 1') || !/run INSTALL section 1/.test(block('ai-w4-keeper-retire')));
  const f = fixture(); prepared(f);
  const durable = ['var-lib-admin-release', 'var-lib-admin-release/archives', 'var-lib-admin-release/archives.json', `var-lib-admin-release/archives/${baseline}-${legacyWid}.tar`, 'var-lib-admin-release/source-metadata.json'].map(p => entryOf(f, p));
  const r = f.run(['ai-w4-keeper-retire']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PASS rollback: five installed files and three enable links absent; durable state retained/, 'section 4 ran to its last line');
  for (const name of ['keeper-adoption.json', 'keeper-retire-attempted.txt', 'keeper-retired.json', 'keeper-INSTALL.md']) assert.ok(proofHas(f, name), name);
  assert.equal(readFileSync(join(f.root, 'proof/keeper-INSTALL.md'), 'utf8'), f.install, 'root copy is the verified upload');
  for (const p of keeperPaths) assert.equal(entryOf(f, p), null, `${p} RETIRED`);
  for (const u of keeperUnits) assert.deepEqual([units(f)[u].load, units(f)[u].active], ['not-found', 'inactive']);
  assert.deepEqual(['var-lib-admin-release', 'var-lib-admin-release/archives', 'var-lib-admin-release/archives.json', `var-lib-admin-release/archives/${baseline}-${legacyWid}.tar`, 'var-lib-admin-release/source-metadata.json'].map(p => entryOf(f, p)), durable, 'durable state kept');
  assert.equal(units(f)[timer].active, 'active', 'section 4 ends with the edge recycle timer active');
  const adoption = f.json('proof/keeper-adoption.json');
  assert.equal(adoption.sha256, f.legacyHash);
  const retired = f.json('proof/keeper-retired.json');
  assert.deepEqual(Object.keys(retired).sort(), ['adoption_sha256', 'ended_at', 'excerpts', 'install_md_sha256', 'install_md_upload', 'keeper_upload_owner', 'kind', 'release_sha', 'started_at', 'window_id']);
  assert.equal(retired.install_md_sha256, hash(f.install)); assert.equal(retired.install_md_upload, join(f.root, f.installUpload));
  assert.equal(retired.keeper_upload_owner, 'ops'); assert.deepEqual(retired.excerpts, f.inputs.keeper_install_excerpts);
  assert.equal(retired.adoption_sha256, hash(readFileSync(join(f.root, 'proof/keeper-adoption.json'))));
  assert.ok(!existsSync(join(f.root, 'trap.log')), 'no INSTALL line outside the four pinned ranges ran');
  assert.ok(r.calls.some(c => c.join(' ') === `systemctl disable --now ${keeperUnits.join(' ')}`), 'section 4 disabled the keeper units');
  // The marker precedes the child shell: the first section 4 command follows the attempt marker.
  assert.ok(r.calls.findIndex(c => c[0] === 'sha256sum' && c[1] === '-c') >= 0);
});

test('H1(d)(b) / keeper-retire-baseline-three-sources: a BASELINE, VARS or unsafe-VARS mismatch stops before the marker; the keeper stays intact', () => {
  const f = fixture(); prepared(f);
  const intact = keeperState(f);
  const vars = join(f.root, 'root', varsName), varsText = readFileSync(vars, 'utf8');
  const cases: Array<[string, () => void, () => void, string]> = [
    ['one baseline byte', () => writeFileSync(join(f.root, `systemd/${service}.d/50-admin-measurement.conf`), reviewedDropin(f.root) + '#'), () => writeFileSync(join(f.root, `systemd/${service}.d/50-admin-measurement.conf`), reviewedDropin(f.root)),
      'live baseline re-measure expected keeper_baseline got mismatch'],
    ['VARS baseline', () => writeFileSync(vars, varsText.replace(/ARCHIVE_KEEPER_BASELINE="[0-9a-f]/, m => m.slice(0, -1) + (m.endsWith('0') ? '1' : '0'))), () => writeFileSync(vars, varsText), 'VARS ARCHIVE_KEEPER_BASELINE expected keeper_baseline got mismatch'],
    ['VARS host', () => writeFileSync(vars, varsText.replace('ARCHIVE_KEEPER_HOST="yulan-vps-1"', 'ARCHIVE_KEEPER_HOST="other-host"')), () => writeFileSync(vars, varsText), 'VARS ARCHIVE_KEEPER_HOST expected keeper_host got mismatch'],
    ['VARS symlink', () => { renameSync(vars, vars + '.real'); symlinkSync(vars + '.real', vars); }, () => { spawnSync('rm', ['--', vars]); renameSync(vars + '.real', vars); }, 'expected regular-single-link-root-0600 got other'],
    ['VARS mode', () => chmodSync(vars, 0o644), () => chmodSync(vars, 0o600), 'expected regular-single-link-root-0600 got other'],
    ['VARS owner', () => f.fixtureConfig({ owners: { [`root/${varsName}`]: [1001, 0] } }), () => f.fixtureConfig({ owners: {} }), 'expected regular-single-link-root-0600 got other'],
  ];
  for (const [name, change, restore, message] of cases) {
    change();
    const r = f.run(['ai-w4-keeper-retire']);
    refused(r, message); assert.ok(r.stderr.includes('a refusal before keeper-retire-attempted.txt leaves the keeper installed'), name);
    assert.ok(!proofHas(f, 'keeper-retire-attempted.txt') && !proofHas(f, 'keeper-retired.json'), `${name}: no attempt marker`);
    assert.deepEqual(keeperState(f), intact, `${name}: every keeper file and link unchanged`);
    assert.ok(!r.calls.some(c => c[0] === 'systemctl' && c[1] === 'disable'), name);
    restore();
    for (const file of ['keeper-adoption.json', 'keeper-INSTALL.md']) if (proofHas(f, file)) spawnSync('rm', ['--', join(f.root, 'proof', file)]);
  }
  pass(f.run(['ai-w4-keeper-retire']), 'positive control after the refusals');
});
function pass(r: { status: number | null; stderr: string }, label: string) { assert.equal(r.status, 0, `${label}: ${r.stderr}`); }

test('H1(d)(c,k) / keeper-retire-install-md: the upload is checked before any excerpt runs; the bundle directory never supplies INSTALL.md', () => {
  const cases: Array<[string, (f: Fixture) => void, string]> = [
    ['INSTALL.md digest pin', f => f.writeInputs({ keeper_install_md_sha256: 'e'.repeat(64) }), 'INSTALL.md upload digest expected keeper_install_md_sha256 got mismatch'],
    ['excerpt pin', f => f.writeInputs({ keeper_install_excerpts: { ...(f.inputs.keeper_install_excerpts as object), quiet: { lines: [63, 75], sha256: 'e'.repeat(64) } } }), 'INSTALL excerpt quiet expected pinned-sha256 got mismatch'],
    ['upload missing', f => renameSync(join(f.root, f.installUpload), join(f.root, 'moved-install')), 'INSTALL.md upload'],
    ['upload symlink', f => { renameSync(join(f.root, f.installUpload), join(f.root, 'moved-install')); symlinkSync(join(f.root, 'moved-install'), join(f.root, f.installUpload)); }, 'expected regular-single-link-file got missing-or-symlink'],
    ['upload one byte', f => writeFileSync(join(f.root, f.installUpload), f.install.replace('set -euo pipefail', 'set -euo pipefaiL')), 'INSTALL.md upload digest expected keeper_install_md_sha256 got mismatch'],
  ];
  for (const [name, change, message] of cases) {
    const f = fixture(); prepared(f); const intact = keeperState(f);
    change(f);
    const r = f.run(['ai-w4-keeper-retire']);
    refused(r, message);
    assert.ok(!quietRan(r), `${name}: no excerpt ran`);
    assert.ok(!proofHas(f, 'keeper-retire-attempted.txt'), `${name}: no attempt marker`);
    assert.deepEqual(keeperState(f), intact, `${name}: keeper INTACT`);
  }
  // A DIFFERENT INSTALL.md in the bundle directory is never read: its trap lines never run.
  const f = fixture(); prepared(f);
  assert.ok(!existsSync(join(f.root, 'keeper-bundle/INSTALL.md')), 'the production bundle holds no INSTALL.md');
  f.put('keeper-bundle/INSTALL.md', installMd(f.root, join(f.root, 'keeper-bundle')).replace(/^set -euo pipefail$/m, `printf 'BUNDLE INSTALL.md ran\\n' >>${join(f.root, 'trap.log')}`));
  pass(f.run(['ai-w4-keeper-retire']), 'upload used despite a bundle INSTALL.md');
  assert.ok(!existsSync(join(f.root, 'trap.log')), 'no line of the bundle copy ran');
});

test('H1(d)(d) / keeper-retire-quiet-slot: exactly 900 s from a recycle slot stops; 901 s passes', () => {
  for (const [clock, ok] of [['2026-10-10T09:15:00Z', false], ['2026-10-10T09:45:00Z', false], ['2026-10-10T09:14:59Z', true], ['2026-10-10T09:45:01Z', true]] as const) {
    const f = fixture(); prepared(f); const intact = keeperState(f);
    f.fixtureConfig({ clock });
    const r = f.run(['ai-w4-keeper-retire']);
    if (ok) { pass(r, clock); assert.ok(proofHas(f, 'keeper-retired.json')); continue; }
    refused(r, 'recycle slot distance expected more-than-900-seconds-from-03:30-09:30-15:30-21:30-UTC got within-15-minutes-or-failure');
    assert.ok(quietRan(r), `${clock}: the reviewed quiet function ran`);
    assert.ok(!proofHas(f, 'keeper-retire-attempted.txt'), `${clock}: refused before the marker`);
    assert.deepEqual(keeperState(f), intact);
  }
});

test('H1(d)(e) / keeper-retire-adoption: a keeper copy, ledger row or ledger digest mismatch stops with the keeper installed', () => {
  const ledger = (f: Fixture) => join(f.root, 'var-lib-admin-release/archives.json');
  const rows = (f: Fixture) => JSON.parse(readFileSync(ledger(f), 'utf8'));
  const cases: Array<[string, (f: Fixture) => void, string]> = [
    ['keeper copy byte', f => writeFileSync(join(f.root, `var-lib-admin-release/archives/${baseline}-${legacyWid}.tar`), 'legacy archive bytes!\n'), 'adoption digests expected bound-equals-live-equals-keeper-copy-equals-ledger got mismatch'],
    ['ledger row missing', f => writeFileSync(ledger(f), JSON.stringify([], null, 2) + '\n'), 'ledger row for ' + `${baseline}-${legacyWid}.tar expected one got missing-or-duplicate`],
    ['ledger digest', f => writeFileSync(ledger(f), JSON.stringify([{ ...rows(f)[0], sha256: 'f'.repeat(64) }], null, 2) + '\n'), 'adoption digests expected bound-equals-live-equals-keeper-copy-equals-ledger got mismatch'],
  ];
  for (const [name, change, message] of cases) {
    const f = fixture(); prepared(f); const intact = keeperState(f);
    change(f);
    const r = f.run(['ai-w4-keeper-retire']);
    refused(r, message);
    assert.ok(!proofHas(f, 'keeper-adoption.json') && !proofHas(f, 'keeper-retire-attempted.txt'), name);
    assert.deepEqual(keeperState(f), intact, `${name}: keeper installed`);
  }
  const control = fixture(); prepared(control);
  pass(control.run(['ai-w4-keeper-retire']), 'positive control');
  assert.ok(proofHas(control, 'keeper-adoption.json'));
});

test('H1(d)(f) / keeper-retire-bundle: a missing bundle or SHA256SUMS mismatch stops inside the child before section 4 removes anything', () => {
  for (const [name, change] of [
    ['bundle missing', (f: Fixture) => renameSync(join(f.root, 'keeper-bundle'), join(f.root, 'moved-bundle'))],
    ['SHA256SUMS mismatch', (f: Fixture) => writeFileSync(join(f.root, 'keeper-bundle/commonswarm-recycle-archive.conf'), 'x /tmp/other-*.tar - - - - -\n')],
  ] as const) {
    const f = fixture(); prepared(f); const intact = keeperState(f);
    change(f);
    const r = f.run(['ai-w4-keeper-retire']);
    refused(r, 'INSTALL section 4 expected exit-0 got exit-1');
    assert.ok(proofHas(f, 'keeper-retire-attempted.txt'), `${name}: the marker precedes the child shell`);
    assert.ok(!proofHas(f, 'keeper-retired.json'));
    assert.deepEqual(keeperState(f), intact, `${name}: keeper INTACT`);
    assert.ok(!r.calls.some(c => c[0] === 'rm' || (c[0] === 'systemctl' && c[1] === 'disable')), `${name}: section 4 removed nothing`);
  }
});

test('H1(d)(g) / w4-apply-requires-keeper-record: ai-w4-apply refuses without keeper-retired.json before any mutation', () => {
  const f = fixture(); prepared(f);
  const r = f.run(['ai-w4-apply']);
  refused(r, 'FAIL ai-w4-apply: keeper-retired.json expected valid-for-this-window got missing-or-other; run ai-w4-keeper-retire first; STOP');
  assert.ok(!r.calls.some(c => c[0] === 'ai_db'), 'no database mutation');
  assert.ok(!proofHas(f, 'edge-attempted.txt'));
  pass(f.run(['ai-w4-keeper-retire', 'ai-w4-apply']), 'positive control');
});

test('H1(d)(h) / w4-rollback-keeper-intact: a rollback with the keeper INTACT closes without the ruling-11 phrase', () => {
  const f = fixture(); prepared(f); f.fixtureConfig({ clock: '2026-10-10T09:20:00Z' });
  refused(f.run(['ai-w4-keeper-retire']), 'recycle slot distance');
  f.fixtureConfig({ clock: '2026-10-10T12:00:00Z' });
  pass(f.run(['ai-w4-rollback']), 'rollback');
  const close = f.run(['ai-close'], { CLOSE_RESULT: 'recovered', LIVE_CONTROLS_FILE: join(f.root, 'proof/ordinary-recovery.json') });
  pass(close, 'recovered close');
  assert.ok(!close.stdout.includes(phrase)); assert.match(readFileSync(join(f.root, 'proof/W4-recovered-close.txt'), 'utf8'), /^keeper INTACT$/m);
  assert.ok(!readFileSync(join(f.root, 'proof/W4-recovered-close.txt'), 'utf8').includes(phrase));
  for (const p of keeperPaths) assert.notEqual(entryOf(f, p), null, `${p} still installed`);
});

test('F-negative / w4-recovered-close-refusals: a tampered restored byte, an unlisted extra file or a keeper file left present refuses the recovered close', () => {
  const f = fixture(); f.fixtureConfig({ fail_calls: [['ln', '-sfT', join(f.root, 'edge/releases', sha), join(f.root, 'edge/current.admin-issuance')]] });
  assert.notEqual(f.run(forward()).status, 0);
  pass(f.run(['ai-w4-rollback']), 'rollback');
  const close = () => f.run(['ai-close'], { CLOSE_RESULT: 'recovered', LIVE_CONTROLS_FILE: join(f.root, 'proof/ordinary-recovery.json') });
  const config = join(f.root, 'admin-release/recycle.json'), configText = readFileSync(config, 'utf8');
  const cases: Array<[string, () => void, () => void, string]> = [
    ['restored byte', () => writeFileSync(config, configText.replace('"release_sha"', '"release_shA"')), () => writeFileSync(config, configText), 'monitored roots expected pre-attempt-snapshot-plus-listed-residue got changed'],
    ['extra file', () => f.put('libexec/unlisted-extra', 'x\n', 0o700), () => spawnSync('rm', ['--', join(f.root, 'libexec/unlisted-extra')]), 'monitored roots expected pre-attempt-snapshot-plus-listed-residue got changed'],
    ['keeper file left present', () => f.put('tmpfiles.d/commonswarm-recycle-archive.conf', 'x /tmp/admin-issuance-*.tar - - - - -\n', 0o600), () => spawnSync('rm', ['--', join(f.root, 'tmpfiles.d/commonswarm-recycle-archive.conf')]), 'keeper expected RETIRED-or-INTACT got partial-retirement'],
  ];
  for (const [name, change, restore, message] of cases) {
    change(); const r = close();
    refused(r, message); assert.ok(r.stderr.includes('FAIL ai-close: recovered W4 exact restoration sets'), name);
    assert.ok(!proofHas(f, 'closed.txt') && !proofHas(f, 'close-result.json'), `${name}: no close record`);
    restore();
  }
  pass(close(), 'positive control after restoring each change');
});

test('A1 / recycle-install-modes: fresh, accept-existing and upgrade-existing are each admitted on their exact state and reach a success close', () => {
  for (const mode of ['fresh', 'accept-existing', 'upgrade-existing']) {
    const f = fixture({}, { mode });
    const r = f.run([...forward(), 'ai-w4-readback']);
    pass(r, mode);
    assert.equal(readFileSync(join(f.root, 'libexec/commonswarm-admin-edge-recycle'), 'utf8'), candidateHook, `${mode}: the candidate hook is installed`);
    assert.equal(readFileSync(join(f.root, `systemd/${service}.d/50-admin-measurement.conf`), 'utf8'), reviewedDropin(f.root), `${mode}: the reviewed drop-in`);
    const binding = JSON.parse(readFileSync(join(f.root, 'admin-release/recycle.json'), 'utf8'));
    assert.deepEqual(Object.keys(binding).sort(), ['archive', 'artifact_digest', 'image_digest', 'postgres_image', 'release_root', 'release_sha', 'target']);
    assert.equal(binding.archive, join(f.root, 'var-lib-admin-release/archives', `${sha}-${wid}.tar`), `${mode}: bound to the durable archive`);
    assert.equal(hash(readFileSync(binding.archive)), f.archiveSha);
    assert.ok(proofHas(f, mode === 'fresh' ? 'keeper-absent.json' : 'keeper-retired.json'));
    const close = f.run(['ai-close'], { CLOSE_RESULT: 'success', LIVE_CONTROLS_FILE: join(f.root, 'proof/ordinary-after.json') });
    pass(close, `${mode} success close`);
    assert.match(close.stdout, /PASS ai-w4-state success/);
  }
});

test('A1 / recycle-install-admission-refusals: each mismatch refuses in preflight before any write; positive control in the same fixture', () => {
  const f = fixture();
  const hook = join(f.root, 'libexec/commonswarm-admin-edge-recycle'), dropin = join(f.root, `systemd/${service}.d/50-admin-measurement.conf`);
  const cases: Array<[string, () => void, () => void, string]> = [
    ['hook byte', () => writeFileSync(hook, legacyHook + '#'), () => writeFileSync(hook, legacyHook), 'expected baseline-receipt-bytes-and-metadata got drift'],
    ['hook uid', () => f.fixtureConfig({ owners: { 'libexec/commonswarm-admin-edge-recycle': [1001, 0] } }), () => f.fixtureConfig({ owners: {} }), 'expected baseline-receipt-bytes-and-metadata got drift'],
    ['hook gid', () => f.fixtureConfig({ owners: { 'libexec/commonswarm-admin-edge-recycle': [0, 1001] } }), () => f.fixtureConfig({ owners: {} }), 'expected baseline-receipt-bytes-and-metadata got drift'],
    ['hook mode', () => chmodSync(hook, 0o755), () => chmodSync(hook, 0o700), 'expected baseline-receipt-bytes-and-metadata got drift'],
    ['hook symlink', () => { renameSync(hook, hook + '.real'); symlinkSync(hook + '.real', hook); }, () => { spawnSync('rm', ['--', hook]); renameSync(hook + '.real', hook); }, 'expected regular-file-or-absent got symlink-or-other'],
    ['drop-in missing', () => renameSync(dropin, join(f.root, 'moved-dropin')), () => renameSync(join(f.root, 'moved-dropin'), dropin), 'expected baseline-receipt-bytes-and-metadata got drift'],
    ['extra drop-in file', () => f.put(`systemd/${service}.d/60-extra.conf`, '[Service]\n', 0o644), () => spawnSync('rm', ['--', join(f.root, `systemd/${service}.d/60-extra.conf`)]), 'expected baseline-receipt-directory-and-entries got drift-or-extra-entry'],
    ['wrong mode selected', () => f.writeInputs({ recycle_install_mode: 'accept-existing' }, r => { r.mode = 'accept-existing'; r.approval = null; }), () => f.writeInputs(), 'existing hook digest expected candidate got other'],
    ['receipt mode differs from INPUTS', () => f.writeInputs({}, r => { r.mode = 'accept-existing'; }), () => f.writeInputs(), 'baseline receipt mode expected input-recycle_install_mode got other'],
    ['missing approval', () => f.writeInputs({}, r => { r.approval = null; }), () => f.writeInputs(), 'hook upgrade approval expected HezLead-approval-object got missing-or-other'],
    ['U10 receipt digest', () => f.writeInputs({ keeper_install_receipt_sha256: 'e'.repeat(64) }), () => f.writeInputs(), 'U10 keeper values expected keeper_install_receipt_sha256-host-baseline-inputs got mismatch'],
    ['receipt digest', () => writeFileSync(join(f.root, 'inputs/recycle-baseline.json'), JSON.stringify(f.receipt()) + ' '), () => f.writeInputs(), 'baseline receipt digest expected input-recycle_baseline_sha256 got mismatch'],
    ['keeper file', () => chmodSync(join(f.root, 'tmpfiles.d/commonswarm-recycle-archive.conf'), 0o644), () => chmodSync(join(f.root, 'tmpfiles.d/commonswarm-recycle-archive.conf'), 0o600), 'expected U10-keeper-file got drift-or-absent'],
  ];
  for (const [name, change, restore, message] of cases) {
    change();
    const r = f.run(['ai-w4-preflight']);
    refused(r, message); assert.ok(r.stderr.includes('FAIL ai-w4-preflight: recycle installation, keeper and A1 baseline receipt expected admitted got refused; STOP'), name);
    assert.ok(!existsSync(join(f.root, 'proof/w4-state')), `${name}: no proof storage written`);
    assert.ok(!existsSync(join(f.root, 'edge/releases', sha)), `${name}: no W4 write`);
    restore();
  }
  pass(f.run(['ai-w4-preflight']), 'positive control');
  for (const name of ['recycle-baseline.json', 'hook.bytes', 'config.bytes', 'dropin.bytes', 'intent.bytes', 'roots-before.json']) assert.ok(existsSync(join(f.root, 'proof/w4-state', name)), name);
  assert.equal(readFileSync(join(f.root, 'proof/w4-state/hook.bytes'), 'utf8'), legacyHook, 'old hook bytes saved for rollback');
});

// Formerly the single-write test in admin-release-live-failclosed-w45.test.ts, rewritten for the three-mode install.
test('release-plan-contract / recycle-install-verified-write: installs exactly the verified hook bytes through a verified temporary file; a corrupted or planted temporary file refuses before the rename', () => {
  const hookPath = 'libexec/commonswarm-admin-edge-recycle', temporary = `libexec/.commonswarm-admin-edge-recycle.${wid}.new`;
  const good = fixture(), r = good.run(forward()); pass(r, 'forward');
  assert.equal(readFileSync(join(good.root, hookPath), 'utf8'), candidateHook, 'installed bytes are the verified extraction');
  assert.equal(statSync(join(good.root, hookPath)).mode & 0o777, 0o700);
  const owners = readFileSync(join(good.root, 'fchown.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(owners.some(c => c[0] === temporary && c[1] === 0 && c[2] === 0), 'root ownership set on the temporary file before the rename');
  assert.ok(!existsSync(join(good.root, temporary)), 'the temporary file was renamed into place');
  assert.equal(readFileSync(join(good.root, `systemd/${service}.d/50-admin-measurement.conf`), 'utf8'), reviewedDropin(good.root));
  assert.ok(existsSync(join(good.root, 'proof/recycle-unit-after.txt')));
  assert.match(r.stdout, /PASS recycle pre-invalidation\/post-measurement hooks installed; no restart performed/);
  // Negative: the temporary file is corrupted after its write; the read-back refuses before the rename.
  const bad = fixture({ corrupt_write: [temporary] }), refusedRun = bad.run(forward());
  refused(refusedRun, `FAIL ai-recycle-install: ${join(bad.root, temporary)} expected verified-temporary-bytes got other; STOP`);
  assert.equal(readFileSync(join(bad.root, hookPath), 'utf8'), legacyHook, 'the live hook is unchanged');
  assert.ok(!existsSync(join(bad.root, 'proof/recycle-unit-after.txt')));
  assert.doesNotMatch(refusedRun.stdout, /PASS recycle pre-invalidation/);
  // Negative: a symlink planted at the temporary path is never written through.
  const planted = fixture(); planted.put('victim.txt', 'must survive\n'); symlinkSync(join(planted.root, 'victim.txt'), join(planted.root, temporary));
  refused(planted.run(forward()), `FAIL ai-recycle-install: ${join(planted.root, temporary)} expected absent got present; an earlier attempt of this window was interrupted; run ai-w4-rollback; STOP`);
  assert.equal(readFileSync(join(planted.root, 'victim.txt'), 'utf8'), 'must survive\n');
  assert.equal(readFileSync(join(planted.root, hookPath), 'utf8'), legacyHook, 'the live hook is unchanged');
});

test('A2 / recycle-install-atomic: an interruption between temporary write and rename leaves the live file unchanged; a rerun refuses; rollback restores exactly', () => {
  for (const target of ['libexec/commonswarm-admin-edge-recycle', 'admin-release/recycle.json']) {
    const f = fixture({ interrupt_replace: [target] });
    const before = monitored(f), live = readFileSync(join(f.root, target));
    const r = f.run(forward());
    refused(r, 'FAIL ai-recycle-install: install expected admitted got refused; STOP');
    assert.deepEqual(readFileSync(join(f.root, target)), live, `${target}: live file unchanged`);
    const temporary = join(dirname(join(f.root, target)), `.${target.split('/').pop()}.${wid}.new`);
    assert.ok(existsSync(temporary), `${target}: the window's temporary file is left for rollback`);
    f.fixtureConfig({ interrupt_replace: [] });
    f.run(['# hold the timer as ai-w4-apply does\nsystemctl stop commonswarm-edge-recycle.timer']);
    refused(f.run(['# rerun of the install alone\nRECYCLE_INSTALL_ACTION=install\nai_run ai-recycle-install']), 'FAIL ai-recycle-install');
    assert.deepEqual(readFileSync(join(f.root, target)), live, `${target}: rerun refused without a write`);
    f.run(['# re-arm, as the apply guard did\nsystemctl start commonswarm-edge-recycle.timer']);
    pass(f.run(['ai-w4-rollback']), 'rollback');
    assert.ok(!existsSync(temporary), 'rollback removed the window-owned temporary file');
    pass(f.run(['ai-close'], { CLOSE_RESULT: 'recovered', LIVE_CONTROLS_FILE: join(f.root, 'proof/ordinary-recovery.json') }), 'recovered close');
    exactRestoration(f, before, monitored(f), { retired: true, promoted: true });
  }
});

test('A7 / w4-success-close: each wrong item refuses the success close', () => {
  const f = fixture();
  pass(f.run([...forward(), 'ai-w4-readback']), 'forward');
  const close = () => f.run(['ai-close'], { CLOSE_RESULT: 'success', LIVE_CONTROLS_FILE: join(f.root, 'proof/ordinary-after.json') });
  const swap = (rel: string, bytes: string) => { const path = join(f.root, rel), old = readFileSync(path); return [() => writeFileSync(path, bytes), () => writeFileSync(path, old)] as const; };
  const durable = `var-lib-admin-release/archives/${sha}-${wid}.tar`;
  const db = f.json('cutover.json'), unitsNow = f.json('units.json');
  const cases: Array<[string, readonly [() => void, () => void]]> = [
    ['hook', swap('libexec/commonswarm-admin-edge-recycle', legacyHook)],
    ['drop-in', swap(`systemd/${service}.d/50-admin-measurement.conf`, reviewedDropin(f.root) + '#')],
    ['binding', swap('admin-release/recycle.json', readFileSync(join(f.root, 'admin-release/recycle.json'), 'utf8').replace(wid, 'Oth999'))],
    ['durable archive', swap(durable, 'other bytes')],
    ['helper tree', [() => renameSync(join(f.root, f.release, 'RELEASE_SHA'), join(f.root, 'moved-release-sha')), () => renameSync(join(f.root, 'moved-release-sha'), join(f.root, f.release, 'RELEASE_SHA'))]],
    ['keeper file still present', [() => f.put('libexec/commonswarm-recycle-archive', keeperHelper(f.root), 0o700), () => spawnSync('rm', ['--', join(f.root, 'libexec/commonswarm-recycle-archive')])]],
    ['timer inactive', [() => f.put('units.json', { ...unitsNow, [timer]: { ...unitsNow[timer], active: 'inactive' } }), () => f.put('units.json', unitsNow)]],
    ['measurement', [() => f.put('cutover.json', { ...db, invalidated: true }), () => f.put('cutover.json', db)]],
    ['measurement receipt missing', [() => renameSync(join(f.root, 'proof/w4-measurement.json'), join(f.root, 'moved-measurement.json')), () => renameSync(join(f.root, 'moved-measurement.json'), join(f.root, 'proof/w4-measurement.json'))]],
    ['measurement receipt of another release', swap('proof/w4-measurement.json', readFileSync(join(f.root, 'proof/w4-measurement.json'), 'utf8').replaceAll(sha, baseline))],
  ];
  for (const [name, [change, restore]] of cases) {
    change(); const r = close();
    refused(r, 'FAIL ai-close: W4 admitted hook, drop-in, durable binding, archive, RETIRED keeper, timer and CLOSED measurement expected exact got other; STOP');
    assert.ok(!proofHas(f, 'closed.txt'), name);
    restore();
  }
  pass(close(), 'positive control');
});

// The reviewed hook, run as systemd runs it, against a bound archive of each shape.
function hookFixture(shape: 'durable' | 'tmp', config: Record<string, unknown> = {}) {
  const f = fixture(config);
  const live = join(f.root, 'edge/releases', sha);
  spawnSync('/usr/bin/python3', ['-c', 'import shutil,sys; shutil.copytree(sys.argv[1],sys.argv[2],symlinks=True)', join(f.root, f.release), live]);
  spawnSync('rm', ['--', join(f.root, 'edge/current')]); symlinkSync(live, join(f.root, 'edge/current'));
  f.put('docker.json', { working_dir: join(live, 'deploy/edge-runtime') });
  const durable = `var-lib-admin-release/archives/${sha}-${wid}.tar`;
  f.put(durable, readFileSync(join(f.root, f.upload)), 0o600);
  const bind = (archive: string, change: Record<string, unknown> = {}) => f.put('admin-release/recycle.json', JSON.stringify({ release_sha: sha, target: live, image_digest: edgeImage,
    artifact_digest: f.archiveSha, archive, postgres_image: postgresImage, release_root: join(f.root, f.release), ...change }, null, 0) + '\n', 0o600);
  bind(join(f.root, shape === 'durable' ? durable : f.upload));
  f.put('libexec/hook-under-test', f.remap(candidateHook), 0o700);
  const run = (mode: string) => {
    const r = spawnSync('/bin/bash', [join(f.root, 'libexec/hook-under-test'), mode], { encoding: 'utf8', timeout: 60_000, cwd: f.root,
      env: { PATH: join(f.root, 'bin'), W4B_ROOT: f.root, PYTHONDONTWRITEBYTECODE: '1', COMMONSWARM_RECYCLE_UNIT: service } });
    assert.ifError(r.error); assert.doesNotMatch(r.stdout + r.stderr, /UNMODELLED/);
    return r;
  };
  const markers = () => existsSync(join(f.root, 'logger.jsonl')) ? readFileSync(join(f.root, 'logger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(JSON.parse(l).at(-1))) : [];
  return { f, run, bind, durable, live, markers };
}

test('A4 / recycle-hook-archive-names: the hook accepts the /tmp and durable names and refuses every other shape', () => {
  // The reviewed hook block extracts and passes bash -n (its digest is recorded in the lane report).
  assert.equal(spawnSync('/bin/bash', ['-n'], { input: candidateHook }).status, 0);
  for (const shape of ['durable', 'tmp'] as const) {
    const h = hookFixture(shape);
    for (const mode of ['before', 'after']) pass(h.run(mode), `${shape} ${mode}`);
    assert.deepEqual(h.markers(), [], `${shape}: a good recycle writes no marker`);
    assert.ok(readFileSync(join(h.f.root, 'hook-sql.jsonl'), 'utf8').includes('measured_artifact_digest'), `${shape}: the after hook measured the archive`);
  }
  const refusals: Array<[string, (h: ReturnType<typeof hookFixture>) => void]> = [
    ['relative path', h => h.bind(h.durable)],
    // String concatenation: path.join would normalize the dot-dot away.
    ['dot-dot', h => h.bind(`${h.f.root}/var-lib-admin-release/archives/../archives/${sha}-${wid}.tar`)],
    ['third prefix', h => { h.f.put(`other/${sha}-${wid}.tar`, readFileSync(join(h.f.root, h.durable)), 0o600); h.bind(join(h.f.root, 'other', `${sha}-${wid}.tar`)); }],
    ['symlinked final component', h => { renameSync(join(h.f.root, h.durable), join(h.f.root, 'real.tar')); symlinkSync(join(h.f.root, 'real.tar'), join(h.f.root, h.durable)); }],
    ['symlinked ancestor', h => { renameSync(join(h.f.root, 'var-lib-admin-release/archives'), join(h.f.root, 'var-lib-admin-release/real-archives')); symlinkSync(join(h.f.root, 'var-lib-admin-release/real-archives'), join(h.f.root, 'var-lib-admin-release/archives')); }],
    ['archive owner', h => h.f.fixtureConfig({ owners: { [h.durable]: [1001, 0] } })],
    ['archive mode', h => chmodSync(join(h.f.root, h.durable), 0o644)],
    ['directory mode', h => chmodSync(join(h.f.root, 'var-lib-admin-release/archives'), 0o755)],
    ['other release in the name', h => { h.f.put(`var-lib-admin-release/archives/${baseline}-${wid}.tar`, readFileSync(join(h.f.root, h.durable)), 0o600); h.bind(join(h.f.root, `var-lib-admin-release/archives/${baseline}-${wid}.tar`)); }],
  ];
  for (const [name, change] of refusals) {
    const h = hookFixture('durable'); change(h);
    const r = h.run('before');
    assert.notEqual(r.status, 0, `${name}: must refuse`);
    refused(r, 'FAIL recycle hook before; issuance state UNKNOWN');
    assert.deepEqual(h.markers().map(m => m.reason), ['recycle-config-invalid'], name);
    assert.ok(!existsSync(join(h.f.root, 'hook-sql.jsonl')), `${name}: refused before any database session`);
  }
  // A digest mismatch passes the name and metadata checks; the after hook refuses on the same in-memory bytes.
  const h = hookFixture('durable'); pass(h.run('before'), 'before');
  h.bind(join(h.f.root, h.durable), { artifact_digest: 'f'.repeat(64) });
  refused(h.run('after'), 'FAIL recycle hook; issuance CLOSED (confirmed by readback)');
  assert.deepEqual(h.markers().map(m => m.reason), ['edge-measurement-failed']);
  // W6's recycle-config reader admits the same two names (its block text, C:5266-5268 at the base).
  const reader = block('ai-w6-activation-checks');
  assert.match(reader, /\(\/tmp\/admin-issuance-\|\/var\/lib\/commonswarm-admin-release\/archives\/\)/);
});

test('H1(d)(j) / ai-prepare-keeper-install-md: W4 verifies KEEPER_INSTALL_MD_FILE before any remote call and checks the uploaded digest', () => {
  function prep(window: string, change: (f: Fixture) => Record<string, unknown> = () => ({})) {
    const f = fixture();
    const install = f.install; f.put('keeper-src/INSTALL.md', install, 0o600);
    const inputs = { ...f.json('inputs.json'), baseline_site_sha: 'c'.repeat(40), window,
      ...(window === 'W4' ? {} : Object.fromEntries(['recycle_install_mode', 'recycle_baseline_sha256', 'keeper_install_receipt_sha256', 'keeper_host', 'keeper_upload_owner', 'keeper_baseline',
        'keeper_install_vars_path', 'keeper_install_md_sha256', 'keeper_install_excerpts'].map(k => [k, undefined]))) };
    f.put('inputs.json', inputs);
    f.put('git-plan.md', planBytes);
    f.fixtureConfig({ git: { rev: { [sha]: sha, ['c'.repeat(12)]: 'c'.repeat(40) }, archive: join(f.root, f.upload), plan: join(f.root, 'git-plan.md') } });
    const extra = change(f);
    const r = f.run(['ai-prepare'], { PLAN_FILE: join(f.root, 'git-plan.md'), KEEPER_INSTALL_MD_FILE: join(f.root, 'keeper-src/INSTALL.md'), ...extra as Record<string, string> });
    const transport = existsSync(join(f.root, 'transport.jsonl')) ? readFileSync(join(f.root, 'transport.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    return { f, r, transport };
  }
  for (const [name, change] of [
    ['digest differs', (f: Fixture) => { f.put('keeper-src/INSTALL.md', f.install + '#'); return {}; }],
    ['missing', (f: Fixture) => { renameSync(join(f.root, 'keeper-src/INSTALL.md'), join(f.root, 'keeper-src/moved')); return {}; }],
    ['symlink', (f: Fixture) => { renameSync(join(f.root, 'keeper-src/INSTALL.md'), join(f.root, 'keeper-src/real')); symlinkSync(join(f.root, 'keeper-src/real'), join(f.root, 'keeper-src/INSTALL.md')); return {}; }],
    ['unset', () => ({ KEEPER_INSTALL_MD_FILE: '' })],
  ] as const) {
    const { r, transport } = prep('W4', change);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /FAIL ai-prepare: KEEPER_INSTALL_MD_FILE expected/, name);
    assert.deepEqual(transport, [], `${name}: zero ssh/scp calls`);
  }
  const good = prep('W4');
  pass(good.r, 'valid W4 upload');
  const box = (suffix: string) => join(good.f.root, `tmp/admin-issuance-${sha}-${wid}${suffix}`);
  assert.deepEqual(good.transport.map(c => [c[0], c.at(-1)]), [
    ['ssh', `test ! -e ${box('.tar')} && (set -C; umask 077; : > ${box('.tar')})`], ['scp', `ops@100.115.66.74:${box('.tar')}`],
    ['ssh', `test ! -e ${box('-keeper-INSTALL.md')} && (set -C; umask 077; : > ${box('-keeper-INSTALL.md')})`], ['scp', `ops@100.115.66.74:${box('-keeper-INSTALL.md')}`],
    ['ssh', `sha256sum -- ${box('-keeper-INSTALL.md')}`]]);
  assert.match(good.r.stdout, new RegExp(`^PASS ai-prepare: archive retained at [^;]+; upload ${box('.tar')} and ${box('-keeper-INSTALL.md')}$`, 'm'));
  assert.equal(readFileSync(join(good.f.root, `remote/admin-issuance-${sha}-${wid}-keeper-INSTALL.md`), 'utf8'), good.f.install, 'the verified bytes were uploaded');
  const wrong = prep('W4', f => { f.fixtureConfig({ remote_digest: 'e'.repeat(64) }); return {}; });
  assert.notEqual(wrong.r.status, 0); assert.match(wrong.r.stderr, /FAIL ai-prepare: uploaded keeper INSTALL.md digest expected keeper_install_md_sha256 got other; STOP/);
  const other = prep('W3', () => ({ KEEPER_INSTALL_MD_FILE: '' }));
  pass(other.r, 'non-W4 window');
  assert.deepEqual(other.transport.map(c => c[0]), ['ssh', 'scp'], 'a non-W4 window uploads only the archive');
  assert.match(other.r.stdout, /^PASS ai-prepare: archive retained at [^;]+; upload [^ ]+\.tar$/m);
});

// A5: the Caddy candidate from the live snapshots, run as a complete block through the fixture.
test('A5 / caddy-candidate-route-states: absent inserts, present-equal keeps the bytes, partial/duplicate/different refuse; one delete per DPoP field', () => {
  const baseBlock = blocksOf(basePlan.stdout).find(b => b.startsWith('# step: ai-w4-caddy-candidate\n'))!;
  const route = 'FAIL ai-w4-caddy-candidate: existing admin route expected absent-or-exact-reviewed-snippets-imports-and-placement got partial-duplicate-or-different; STOP';
  const candidate = (mcp: string, api: string, source?: string) => {
    const f = fixture(); f.put('stage/mcp.caddy', mcp); f.put('stage/api.caddy', api);
    const r = f.run([source === undefined ? 'ai-w4-caddy-candidate' : '# the base block\n' + f.remap(source)]);
    const out = (name: string) => existsSync(join(f.root, 'stage', name)) ? readFileSync(join(f.root, 'stage', name), 'utf8') : null;
    return { r, mcp: out('mcp.new.caddy'), api: out('api.new.caddy'), f };
  };
  const f0 = fixture(), liveMcp = readFileSync(join(f0.root, 'stage/mcp.caddy'), 'utf8'), liveApi = readFileSync(join(f0.root, 'stage/api.caddy'), 'utf8');
  // Absent: the reviewed insertion, byte for byte what the base block produced from the same live files.
  const absent = candidate(liveMcp, liveApi), old = candidate(liveMcp, liveApi, baseBlock);
  pass(absent.r, 'absent'); pass(old.r, 'base block');
  assert.equal(absent.mcp, old.mcp); assert.equal(absent.api, old.api);
  assert.match(absent.r.stdout, /admin route absent; reviewed snippets and imports inserted; 16 DPoP field deletes inserted/);
  assert.match(absent.r.stdout, /PASS W4 both Caddy candidate routes validated; CORS preserved/);
  // Present and equal (the first pass's result): the live bytes are kept exactly.
  const equal = candidate(absent.mcp!, absent.api!);
  pass(equal.r, 'present-equal'); assert.equal(equal.mcp, absent.mcp); assert.equal(equal.api, absent.api);
  assert.match(equal.r.stdout, /admin route present and equal to the reviewed route; bytes kept; 0 DPoP field deletes inserted/);
  const refusals: Array<[string, string, string, string]> = [
    ['partial: snippet without its import', absent.mcp!, absent.api!.replace('\timport admin_resource_active\n\n', ''), route],
    ['partial: MCP import only', absent.mcp!, liveApi, route],
    ['duplicate import', absent.mcp!.replace('import admin_gate_active', 'import admin_gate_active\n\t\timport admin_gate_active'), absent.api!, route],
    ['duplicate snippet', absent.mcp!, absent.api! + absent.api!.slice(0, absent.api!.indexOf('api.commonswarm.com {')), route],
    ['different upstream timeout', absent.mcp!, absent.api!.replace('response_header_timeout 165s', 'response_header_timeout 60s'), route],
    ['DPoP duplicated', liveMcp.replace('request>headers>Authorization delete', 'request>headers>Authorization delete\n\t\t\trequest>headers>DPoP delete\n\t\t\trequest>headers>DPoP delete'), liveApi,
      'FAIL ai-w4-caddy-candidate: mcp.new.caddy request>headers>DPoP expected at-most-one got duplicate; STOP'],
    ['DPoP conflicting definition', liveMcp, liveApi.replace('resp_headers>Authorization delete', 'resp_headers>Authorization delete\n\t\t\tresp_headers>Dpop-Nonce replace x'),
      'FAIL ai-w4-caddy-candidate: api.new.caddy resp_headers>Dpop-Nonce expected delete got conflicting-definition; STOP'],
  ];
  for (const [name, mcp, api, message] of refusals) {
    const r = candidate(mcp, api);
    refused(r.r, message); assert.equal(r.mcp, null, `${name}: no candidate written`); assert.equal(r.api, null, name);
    assert.ok(!existsSync(join(r.f.root, 'stage/sites')), `${name}: refused before the full candidate`);
  }
  // DPoP partly present: only the missing fields are inserted, each field once.
  const partly = candidate(liveMcp.replace('request>headers>Authorization delete', 'request>headers>Authorization delete\n\t\t\trequest>headers>Dpop delete'), liveApi);
  pass(partly.r, 'DPoP partly present'); assert.match(partly.r.stdout, /15 DPoP field deletes inserted/);
  for (const field of ['DPoP', 'Dpop', 'DPoP-Nonce', 'Dpop-Nonce']) assert.equal(partly.mcp!.split(`request>headers>${field} delete\n`).length - 1, 1, field);
});

// A6: ai-w4-apply's read-only fence and OPEN checks precede every write; the singleton is kept before and after.
test('A6 / w4-apply-fence-and-measurement: a drifted fence or OPEN issuance refuses before any write; a canonical snapshot before the overwrite and a receipt after it', () => {
  const noWrite = (f: Fixture, r: ReturnType<Fixture['run']>, message: string, label: string) => {
    refused(r, message);
    assert.ok(!r.calls.some(c => c[0] === 'ai_db'), `${label}: no database write`);
    assert.ok(!proofHas(f, 'edge-attempted.txt') && !proofHas(f, 'cutover-before-measurement.json'), `${label}: stopped before the attempt`);
    assert.equal(f.json('units.json')[timer].active, 'active', `${label}: the timer was never stopped`);
  };
  const drift = fixture({ fence_drift: true });
  noWrite(drift, drift.run(forward()), 'FAIL ai-w4-apply: existing legacy fence expected complete got drifted; STOP', 'fence drift');
  const open = fixture(); open.put('cutover.json', { ...open.json('cutover.json'), enabled: true });
  noWrite(open, open.run(forward()), 'FAIL ai-w4-apply: admin issuance expected CLOSED before the W4 close got OPEN; HezLead inspects it; STOP', 'issuance OPEN');
  // Positive control: the snapshot is canonical, taken before the measurement statement; the receipt binds it.
  const f = fixture(), r = f.run(forward()); pass(r, 'forward');
  const raw = readFileSync(join(f.root, 'proof/cutover-before-measurement.json'), 'utf8'), row = JSON.parse(raw);
  const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v !== null && typeof v === 'object'
    ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}' : JSON.stringify(v);
  assert.equal(raw, canonical(row) + '\n'); assert.equal(Object.keys(row).length, 19);
  assert.equal(row.invalidated_at === null, false, 'taken after the close/invalidate update');
  const snapshotAt = r.calls.findIndex(c => c[0] === 'ai_ro' && c[2] === '--command' && String(c[3]).startsWith("SELECT json_build_object('singleton',singleton,"));
  const measureAt = r.calls.findIndex(c => c[0] === 'ai_db' && c[2] === '--file' && c[3] === join(f.root, 'proof/measure.sql'));
  assert.ok(snapshotAt >= 0 && measureAt > snapshotAt, 'snapshot before the measurement overwrite');
  const receipt = JSON.parse(readFileSync(join(f.root, 'proof/w4-measurement.json'), 'utf8'));
  assert.deepEqual([receipt.kind, receipt.release_sha, receipt.before_sha256, receipt.after.measured_edge_release_sha, receipt.legacy_fence_complete],
    ['c1-w4-measurement', sha, hash(raw), sha, true]);
  assert.ok(receipt.after.release_generation > row.release_generation);
  // The fence predicates are EDGE-RELEASE.md's edge_fence projection (E:430-447), line for line.
  const edgeRelease = readFileSync('deploy/edge-runtime/EDGE-RELEASE.md', 'utf8');
  const projection = edgeRelease.slice(edgeRelease.indexOf('WITH revoked_roles(role_name) AS ('), edgeRelease.indexOf('= t\n}\nedge_invalidate()'));
  const predicates = projection.split('\n').map(l => l.trim().replace(/^AND /, '').replace(/\)+;"\)"( = t)?$/, '')).filter(l => /admin_credentials|admin_grants|revoked_roles WHERE/.test(l));
  assert.equal(predicates.length, 7, 'the E projection has seven predicate lines');
  for (const line of predicates) assert.ok(block('ai-w4-apply').includes(line), `E predicate in ai-w4-apply: ${line}`);
  // A first fence (legacy_closed false) is applied by apply_legacy_admin_fence in the same statement file.
  const first = fixture(); first.put('cutover.json', { ...first.json('cutover.json'), legacy_closed: false });
  pass(first.run(forward()), 'first fence');
});

// A8: the edge reaches R only through W4; a tree at R before W4's preflight refuses.
test('A8 / w4-preflight-r-tree-absent: an R edge tree present at preflight refuses before the copy', () => {
  const f = fixture(); f.put(`edge/releases/${sha}/marker.txt`, 'left by another path\n');
  const r = f.run(['ai-w4-preflight']);
  refused(r, 'FAIL ai-w4-preflight: new edge release directory expected absent got present');
  assert.deepEqual(readdirSync(join(f.root, 'edge/releases', sha)), ['marker.txt'], 'nothing was copied into it');
  assert.match(block('ai-w4-preflight'), /^test ! -e "\$NEW_EDGE" \|\|/m);
});


// X2: ai-gates (Mac) opens the two lock-order receipts and checks them against INPUTS and the repository (rules 1-12).
const lockGates = ['admin-principal-lock-order-ci', 'admin-principal-lock-order-staging'] as const;
const gatesContract = JSON.parse(readFileSync(join(dirname(planPath), 'GATES.json'), 'utf8')) as { gates: Record<string, string[]>; windows: Record<string, string[]> };
const lockControls = gatesContract.gates['admin-principal-lock-order-ci']!;
function x2(options: { treesDiffer: boolean }) {
  const root = realpathSync(mkdtempSync(join(scratch, 'x2-'))), bin = join(root, 'bin'), evidence = join(root, 'evidence');
  mkdirSync(bin); mkdirSync(evidence);
  const T = 'e'.repeat(40), R = sha, TEST = 'tests/p1-server/admin-principal-lock-order.test.ts', testBytes = 'lock-order test bytes\n';
  const versionsT = ['20261001000001', '20261002000001'], onlyR = options.treesDiffer ? ['20261011000001', '20261011000002'] : [];
  const tree = (versions: string[]) => versions.map(v => `supabase/migrations/${v}_fixture.sql`).concat(['supabase/migrations/README.md']).join('\n') + '\n';
  const git = { show: { [`${R}:${TEST}`]: testBytes, [`${T}:${TEST}`]: testBytes }, diff: 0,
    trees: { [T]: '1'.repeat(40), [R]: options.treesDiffer ? '2'.repeat(40) : '1'.repeat(40) },
    ls: { [T]: tree(versionsT), [R]: tree([...versionsT, ...onlyR]) } };
  writeFileSync(join(bin, 'git'), String.raw`#!/usr/bin/python3
import json,os,sys
cfg=json.load(open(os.path.join(os.environ['X2_ROOT'],'git.json'))); a=sys.argv[1:]
with open(os.path.join(os.environ['X2_ROOT'],'git-calls.jsonl'),'a') as log: log.write(json.dumps(a)+'\n')
if len(a)==2 and a[0]=='show' and a[1] in cfg['show']: sys.stdout.write(cfg['show'][a[1]])
elif a[:2]==['diff','--quiet'] and len(a)>=5 and a[4]=='--': raise SystemExit(cfg['diff'])
elif len(a)==2 and a[0]=='rev-parse' and a[1].endswith(':supabase/migrations') and a[1][:40] in cfg['trees']: print(cfg['trees'][a[1][:40]])
elif a[:2]==['ls-tree','--name-only'] and len(a)==5 and a[3:]==['--','supabase/migrations/'] and a[2] in cfg['ls']: sys.stdout.write(cfg['ls'][a[2]])
else: sys.stderr.write('UNMODELLED git '+repr(a)+'\n'); raise SystemExit(99)
`, { mode: 0o700 });
  const results = (run: 'base' | 'lane') => Object.fromEntries(lockControls.map((c, i) => [c, run === 'lane' || i === 0 ? 'PASS' : 'FAIL-40P01']));
  const ci: any = { kind: 'ci', release_sha: R, base_variant_sha: T, test_file_sha256: hash(testBytes), runs: {
    base: { run_url: 'https://github.com/yulanventures/commonswarm/actions/runs/101', run_id: 101, sha: T, migration_sha: git.trees[T], results: results('base') },
    lane: { run_url: 'https://github.com/yulanventures/commonswarm/actions/runs/102', run_id: 102, sha: R, migration_sha: git.trees[R], results: results('lane') } } };
  const project = 'c1b-x2-ab12cd34';
  const stagingRun = (run: 'base' | 'lane', runSha: string, file: string, digit: string) => ({ sha: runSha, migration_sha: git.trees[runSha],
    backup: { file, sha256: digit.repeat(64), source_host: 'c1-staging-1', dump_completed_at: '2026-10-10T10:00:00Z' },
    restore: { db_container_id: digit.repeat(64).replace(/^./, 'f'), database: 'postgres', restore_started_at: '2026-10-10T10:10:00Z', restored_at: '2026-10-10T10:12:00Z', ledger_versions: [...versionsT] },
    applied_versions: run === 'base' ? [] : [...onlyR], results: results(run) });
  const st: any = { kind: 'staging', release_sha: R, base_variant_sha: T, test_file_sha256: hash(testBytes), host: 'c1-staging-1', compose_project: project,
    compose_network: `${project}-net`, compose_volume: `${project}-pgdata`, postgres_image_digest: postgresImage,
    runs: { base: stagingRun('base', T, '/srv/c1-staging/x2/base.dump', 'a'), lane: stagingRun('lane', R, '/srv/c1-staging/x2/lane.dump', 'b') } };
  const inputs: any = { release_sha: R, window: 'W6', lock_order_base_variant_sha: T };
  const run = (change: (c: { ci: any; st: any; git: any; inputs: any; receipt: any }) => void = () => {}) => {
    const c = { ci: structuredClone(ci), st: structuredClone(st), git: structuredClone(git), inputs: structuredClone(inputs), receipt: null as any };
    const files: Record<string, string> = {};
    for (const name of gatesContract.windows.W6!) files[name] = name === lockGates[0] ? '' : name === lockGates[1] ? '' : JSON.stringify({ gate: name }) + '\n';
    c.receipt = { release_sha: R, evidence_root: evidence, gates: Object.fromEntries(gatesContract.windows.W6!.map(name => [name, { status: 'PASS', controls: gatesContract.gates[name], file: `${name}.json`, sha256: '' }])) };
    change(c);
    files[lockGates[0]] = JSON.stringify(c.ci) + '\n'; files[lockGates[1]] = JSON.stringify(c.st) + '\n';
    for (const [name, gate] of Object.entries(c.receipt.gates) as Array<[string, any]>) {
      if (!gate || typeof gate !== 'object' || gate.sha256 !== '') continue;
      const body = files[name] ?? '{}\n'; writeFileSync(join(evidence, gate.file), body); gate.sha256 = hash(body);
    }
    writeFileSync(join(root, 'git.json'), JSON.stringify(c.git)); writeFileSync(join(root, 'inputs.json'), JSON.stringify(c.inputs)); writeFileSync(join(root, 'receipt.json'), JSON.stringify(c.receipt));
    const r = spawnSync('/bin/bash', [], { input: 'set -euo pipefail\n' + block('ai-gates'), encoding: 'utf8', timeout: 30_000, cwd: root,
      env: { PATH: `${bin}:/usr/bin:/bin`, X2_ROOT: root, INPUTS_FILE: join(root, 'inputs.json'), GATE_RECEIPT_FILE: join(root, 'receipt.json'), PLAN_FILE: planPath } });
    assert.ifError(r.error); assert.doesNotMatch(r.stderr, /UNMODELLED|Traceback/);
    return r;
  };
  const gitCalls = () => readFileSync(join(root, 'git-calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)[0]);
  return { run, T, R, onlyR, versionsT, gitCalls };
}

test('X2 / lock-order-gates-contract: GATES.json lists both gates with the ten controls in W6 and every later window that can open issuance', () => {
  assert.deepEqual(lockControls, ['positive-control-raw-sql-base-order-deadlocks', 'admin-oauth-vs-hosted-claim-seat', 'admin-oauth-vs-local-join-registration',
    'admin-oauth-vs-local-command-creation', 'accept-invitation-vs-hosted-claim-seat', 'accept-invitation-vs-local-join-registration',
    'remove-member-vs-hosted-claim-seat', 'remove-member-vs-local-join-registration', 'household-invitation-vs-hosted-claim-seat',
    'household-invitation-vs-local-join-registration']);
  assert.deepEqual(gatesContract.gates['admin-principal-lock-order-staging'], lockControls);
  const withGates = Object.entries(gatesContract.windows).filter(([, names]) => lockGates.every(g => names.includes(g))).map(([w]) => w);
  assert.deepEqual(withGates, ['W6', 'W7']);
  assert.ok(!Object.values(gatesContract.windows).some(names => lockGates.some(g => names.includes(g)) && !lockGates.every(g => names.includes(g))));
  // The windows whose blocks can set admin_issuance_enabled true: W6 activation (enabled=true) and W7's remeasure reopen.
  assert.match(block('ai-w6-activation-apply'), /admin_issuance_enabled=true/);
  assert.match(plan, /reopens only a previously open/);
  assert.doesNotMatch(plan, /479a3458/, 'no migration-tree SHA constant in C');
});

test('X2 / lock-order-receipts-admit: both receipts admit with equal and with different migration trees, and at the interval bounds', () => {
  for (const treesDiffer of [false, true]) {
    const f = x2({ treesDiffer });
    const ok = f.run(); assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /PASS ai-gates/);
    assert.deepEqual([...new Set(f.gitCalls())].sort(), ['diff', 'ls-tree', 'rev-parse', 'show'], 'the positive control reached every repository check');
    for (const restore of ['2026-10-10T10:00:00Z', '2026-10-10T11:00:00Z']) {
      const r = f.run(c => { for (const run of ['base', 'lane']) { c.st.runs[run].restore.restore_started_at = restore; c.st.runs[run].restore.restored_at = '2026-10-10T11:05:00Z'; } });
      assert.equal(r.status, 0, `interval to ${restore}: ${r.stderr}`);
    }
  }
});

test('X2 / lock-order-receipts-refuse: each rule refuses its drifted receipt, input or repository fact', () => {
  const f = x2({ treesDiffer: true }), T = f.T;
  const cases: Array<[string, (c: any) => void, string]> = [
    ['missing CI gate', c => { delete c.receipt.gates['admin-principal-lock-order-ci']; }, 'admin-principal-lock-order-ci PASS'],
    ['missing staging gate', c => { delete c.receipt.gates['admin-principal-lock-order-staging']; }, 'admin-principal-lock-order-staging PASS'],
    ['both gates name the same file', c => { c.receipt.gates['admin-principal-lock-order-staging'].file = 'admin-principal-lock-order-ci.json'; c.st = c.ci; }, 'lock-order rule 1'],
    ['staging receipt of kind ci', c => { c.st.kind = 'ci'; }, 'lock-order rule 2: staging receipt keys and kind'],
    ['one lane control FAIL', c => { c.ci.runs.lane.results[lockControls[3]!] = 'FAIL-40P01'; }, 'lock-order rule 8: CI lane results'],
    ['one base race control PASS', c => { c.st.runs.base.results[lockControls[5]!] = 'PASS'; }, 'lock-order rule 8: staging base results'],
    ['stale lane run SHA', c => { c.ci.runs.lane.sha = 'c'.repeat(40); }, 'lock-order rule 5: CI run SHAs'],
    ['base run SHA not the base variant', c => { c.st.runs.base.sha = 'c'.repeat(40); }, 'lock-order rule 5: staging run SHAs'],
    ['base_variant_sha other than the input', c => { c.inputs.lock_order_base_variant_sha = 'c'.repeat(40); }, 'lock-order rule 4: CI base_variant_sha'],
    ['lock_order_base_variant_sha missing', c => { delete c.inputs.lock_order_base_variant_sha; }, 'FAIL ai-gates: lock_order_base_variant_sha; STOP'],
    ['test digests differ between receipts', c => { c.st.test_file_sha256 = 'e'.repeat(64); }, 'lock-order rule 6: equal test_file_sha256'],
    ['test digest not the bytes at R', c => { c.git.show[`${f.R}:tests/p1-server/admin-principal-lock-order.test.ts`] = 'other bytes\n'; }, 'lock-order rule 6: test bytes at R and T'],
    ['test-side files differ between T and R', c => { c.git.diff = 1; }, 'lock-order repository check git diff'],
    ['CI base migration tree', c => { c.ci.runs.base.migration_sha = '3'.repeat(40); }, 'lock-order rule 7: CI run migration trees'],
    ['CI lane migration tree', c => { c.ci.runs.lane.migration_sha = '3'.repeat(40); }, 'lock-order rule 7: CI run migration trees'],
    ['staging base migration tree', c => { c.st.runs.base.migration_sha = '3'.repeat(40); }, 'lock-order rule 7: staging run migration trees'],
    ['staging lane migration tree', c => { c.st.runs.lane.migration_sha = '3'.repeat(40); }, 'lock-order rule 7: staging run migration trees'],
    ['base and lane trees swapped', c => { for (const rec of [c.ci, c.st]) [rec.runs.base.migration_sha, rec.runs.lane.migration_sha] = [rec.runs.lane.migration_sha, rec.runs.base.migration_sha]; }, 'lock-order rule 7: CI run migration trees'],
    ['run without migration_sha', c => { delete c.ci.runs.base.migration_sha; }, 'lock-order rule 2: CI base run keys'],
    ['round-D top-level migration_sha', c => { c.ci.migration_sha = '1'.repeat(40); }, 'lock-order rule 2: CI receipt keys and kind'],
    ['staging image_digests', c => { c.st.image_digests = {}; }, 'lock-order rule 2: staging receipt keys and kind'],
    ['staging without postgres_image_digest', c => { delete c.st.postgres_image_digest; }, 'lock-order rule 2: staging receipt keys and kind'],
    ['malformed postgres_image_digest', c => { c.st.postgres_image_digest = 'sha256:' + 'A'.repeat(64); }, 'lock-order rule 9: postgres_image_digest'],
    ['live compose project', c => { c.st.compose_project = 'commonswarm-supabase-stack'; c.st.compose_network = 'commonswarm-supabase-stack-net'; c.st.compose_volume = 'commonswarm-supabase-stack-pgdata'; }, 'lock-order rule 9: compose_project'],
    ['live network', c => { c.st.compose_network = 'commonswarm-net'; }, 'lock-order rule 9: network and volume of the project'],
    ['project outside the pattern', c => { c.st.compose_project = 'c1b-x2-AB12CD34'; c.st.compose_network = 'c1b-x2-AB12CD34-net'; c.st.compose_volume = 'c1b-x2-AB12CD34-pgdata'; }, 'lock-order rule 9: compose_project'],
    ['volume not derived from the project', c => { c.st.compose_volume = 'pgdata'; }, 'lock-order rule 9: network and volume of the project'],
    ['run without backup', c => { delete c.st.runs.lane.backup; }, 'lock-order rule 2: staging lane run keys'],
    ['round-E top-level backup', c => { c.st.backup = c.st.runs.base.backup; }, 'lock-order rule 2: staging receipt keys and kind'],
    ['backup extra key', c => { c.st.runs.base.backup.size = 1; }, 'lock-order rule 2: staging base backup keys'],
    ['restore missing key', c => { delete c.st.runs.base.restore.database; }, 'lock-order rule 2: staging base restore keys'],
    ['relative backup file', c => { c.st.runs.base.backup.file = 'base.dump'; }, 'lock-order rule 10: base backup identity'],
    ['malformed backup digest', c => { c.st.runs.lane.backup.sha256 = 'b'.repeat(63); }, 'lock-order rule 10: lane backup identity'],
    ['backup from another host', c => { c.st.runs.lane.backup.source_host = 'yulan-vps-1'; }, 'lock-order rule 10: lane backup identity'],
    ['missing dump_completed_at', c => { delete c.st.runs.base.backup.dump_completed_at; }, 'lock-order rule 2: staging base backup keys'],
    ['missing restore_started_at', c => { delete c.st.runs.base.restore.restore_started_at; }, 'lock-order rule 2: staging base restore keys'],
    ['malformed dump_completed_at', c => { c.st.runs.base.backup.dump_completed_at = '2026-10-10 10:00:00'; }, 'lock-order rule 10: base backup.dump_completed_at'],
    ['malformed restore_started_at', c => { c.st.runs.lane.restore.restore_started_at = '2026-10-10T10:10:00+00:00'; }, 'lock-order rule 10: lane restore.restore_started_at'],
    ['negative interval', c => { c.st.runs.base.restore.restore_started_at = '2026-10-10T09:59:59Z'; }, 'lock-order rule 10: base dump-to-restore interval 0-3600 s'],
    ['interval over 60 minutes', c => { c.st.runs.base.restore.restore_started_at = '2026-10-10T11:00:01Z'; c.st.runs.base.restore.restored_at = '2026-10-10T11:02:00Z'; }, 'lock-order rule 10: base dump-to-restore interval 0-3600 s'],
    ['shared backup file', c => { c.st.runs.lane.backup.file = c.st.runs.base.backup.file; }, 'lock-order rule 10: one backup per run'],
    ['shared backup digest', c => { c.st.runs.lane.backup.sha256 = c.st.runs.base.backup.sha256; }, 'lock-order rule 10: one backup per run'],
    ['restored before its start', c => { c.st.runs.lane.restore.restored_at = '2026-10-10T10:09:59Z'; }, 'lock-order rule 11: lane restored after its start'],
    ['same container in both runs', c => { c.st.runs.lane.restore.db_container_id = c.st.runs.base.restore.db_container_id; }, 'lock-order rule 11: one restore per run'],
    ['base ledger with an R-only version', c => { c.st.runs.base.restore.ledger_versions = [...f.versionsT, f.onlyR[0]]; c.st.runs.base.applied_versions = []; }, 'lock-order rule 12: base restored ledger within its tree'],
    ['applied misses a tree version', c => { c.st.runs.lane.applied_versions = [f.onlyR[0]]; }, 'lock-order rule 12: lane applied_versions'],
    ['applied holds a restored version', c => { c.st.runs.lane.applied_versions = [f.versionsT[1], ...f.onlyR]; }, 'lock-order rule 12: lane applied_versions'],
    ['applied unsorted', c => { c.st.runs.lane.applied_versions = [...f.onlyR].reverse(); }, 'lock-order rule 12: lane applied_versions'],
  ];
  for (const [name, change, message] of cases) {
    const r = f.run(change);
    assert.notEqual(r.status, 0, `${name}: must refuse`);
    assert.ok(r.stderr.includes(message), `${name}: expected ${message}; observed ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /PASS ai-gates/, name);
  }
  assert.ok(T !== f.R);
});

// FU #12: the rollback removes a drop-in or config directory that this window created; one that existed is kept.
test('#12 / w4-rollback-created-directories: a W4-created drop-in or config directory ends absent; a pre-existing one ends present', () => {
  for (const [label, prepare, expectDropin, expectConfig] of [
    ['W4 created the drop-in directory', (_f: Fixture) => {}, false, true],
    ['the drop-in directory pre-existed (empty)', (f: Fixture) => { mkdirSync(join(f.root, `systemd/${service}.d`), { mode: 0o755 }); chmodSync(join(f.root, `systemd/${service}.d`), 0o755); }, true, true],
    ['W4 created the config directory too', (f: Fixture) => { spawnSync('rmdir', ['--', join(f.root, 'admin-release')]); }, false, false],
  ] as const) {
    const f = fixture({}, { mode: 'fresh' });
    prepare(f); f.writeInputs();
    const before = monitored(f);
    const r = f.run(forward(), { W4B_FAULT: 'F3' });
    assert.match(r.stderr, /DRIVER FAULT F3 after ai-recycle-install completed/, `${label}: ${r.stderr}`);
    assert.ok(existsSync(join(f.root, `systemd/${service}.d/50-admin-measurement.conf`)), `${label}: the fresh install wrote the drop-in`);
    pass(f.run(['ai-w4-rollback']), `${label}: rollback`);
    assert.equal(existsSync(join(f.root, `systemd/${service}.d`)), expectDropin, `${label}: drop-in directory`);
    assert.equal(existsSync(join(f.root, 'admin-release')), expectConfig, `${label}: config directory`);
    if (expectDropin) assert.deepEqual(readdirSync(join(f.root, `systemd/${service}.d`)), [], `${label}: kept empty`);
    pass(f.run(['ai-close'], { CLOSE_RESULT: 'recovered', LIVE_CONTROLS_FILE: join(f.root, 'proof/ordinary-recovery.json') }), `${label}: recovered close`);
    exactRestoration(f, before, monitored(f), { retired: false, promoted: true });
  }
});


test('M13 / w4-preflight-override-equals-archive: a one-byte drift of the baseline override refuses in preflight before any write; the equal file passes', () => {
  const override = `edge/releases/${baseline}/deploy/edge-runtime/compose.override.yaml`;
  for (const [label, bytes] of [['one byte changed', 'reviewed overridf\n'], ['one byte appended', 'reviewed override\n\n']] as const) {
    const f = fixture(); f.put(override, bytes, 0o644);
    const before = monitored(f), proofBefore = readdirSync(join(f.root, 'proof')).sort();
    const r = f.run(['ai-w4-preflight']);
    refused(r, 'FAIL ai-w4-preflight: baseline compose.override.yaml expected equal-to-the-verified-archive-member got different-or-unreadable; STOP');
    assert.deepEqual(monitored(f), before, `${label}: no monitored write`);
    assert.deepEqual(readdirSync(join(f.root, 'proof')).sort(), proofBefore, `${label}: no admission or snapshot receipt`);
    assert.ok(!existsSync(join(f.root, 'edge/releases', sha)), `${label}: no R tree`);
  }
  // Positive control in the same fixture shape: the equal file passes, and the R tree receives those bytes.
  const good = fixture(); pass(good.run(['ai-w4-preflight']), 'equal override');
  assert.equal(readFileSync(join(good.root, 'edge/releases', sha, 'deploy/edge-runtime/compose.override.yaml'), 'utf8'), 'reviewed override\n');
});

// M14: every AND-list meant as a STOP is one guarded test per line. Each site is cut from the reviewed block and run under set -e.
const baseBlocks = blocksOf(basePlan.stdout);
const baseBlock = (step: string) => baseBlocks.find(b => b.startsWith(`# step: ${step}\n`))!;
const unguardedAnd = (source: string) => source.match(/^[ \t]*test [^\n|]*&&[^\n|]*$/gm) ?? [];
function underSetE(snippet: string, env: Record<string, string>, args: string[] = []) {
  const r = spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${snippet}\nprintf 'REACHED\\n'\n`, 'm14', ...args],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
function stopsWith(r: ReturnType<typeof underSetE>, fail: string, label: string) {
  assert.notEqual(r.status, 0, `${label}: must stop`); assert.ok(r.stderr.includes(fail), `${label}: expected ${fail}; observed ${JSON.stringify(r.stderr)}`);
  assert.doesNotMatch(r.stdout, /REACHED/, `${label}: nothing after the check runs`);
}
function reaches(r: ReturnType<typeof underSetE>, label: string) { assert.equal(r.status, 0, `${label}: ${r.stderr}`); assert.match(r.stdout, /REACHED/, label); }

test('M14 / and-list-stops: each rewritten site stops with its FAIL line when either test is false and passes when both are true', () => {
  // Enumerate: the five base AND-lists are gone and no new one appeared.
  assert.equal(baseBlocks.flatMap(unguardedAnd).length, 5, 'positive control: the scan finds the five base sites');
  assert.deepEqual(blocks.flatMap(unguardedAnd), []);
  const dir = realpathSync(mkdtempSync(join(scratch, 'm14-')));
  const file = (name: string) => { const path = join(dir, name); writeFileSync(path, 'bytes\n'); return path; };
  const link = (name: string, target: string) => { const path = join(dir, name); symlinkSync(target, path); return path; };
  const one = (source: string, re: RegExp, count: number) => { const m = source.match(re) ?? []; assert.equal(m.length, count, String(re)); return m.join('\n'); };

  // Site 1: ai-w5-recovery-transfer, the Mac transfer loop (every file, including a non-final one).
  const loop = one(block('ai-w5-recovery-transfer'), /^for SITE_C1_FILE in [^\n]*\n(?: [^\n]*\n)*?done$/gm, 1);
  const loopEnv = { INPUTS_FILE: file('inputs.json'), LIVE_CONTROLS_FILE: file('live.json'), CONSENT_RECEIPT_FILE: file('consent.json'), PREP_DIR: dir };
  file('release.tar'); reaches(underSetE(loop, loopEnv), 'site 1 all regular');
  stopsWith(underSetE(loop, { ...loopEnv, INPUTS_FILE: join(dir, 'absent.json') }), `FAIL ai-w5-recovery-transfer: ${join(dir, 'absent.json')} expected regular-file got missing-or-other; STOP`, 'site 1 first test false');
  stopsWith(underSetE(loop, { ...loopEnv, INPUTS_FILE: link('inputs-link.json', loopEnv.INPUTS_FILE) }), `FAIL ai-w5-recovery-transfer: ${join(dir, 'inputs-link.json')} expected not-symlink got symlink; STOP`, 'site 1 second test false');
  const baseLoop = one(baseBlock('ai-w5-recovery-transfer'), /^for SITE_C1_FILE in [^\n]*\n(?: [^\n]*\n)*?done$/gm, 1);
  reaches(underSetE(baseLoop, { ...loopEnv, INPUTS_FILE: join(dir, 'absent.json') }), 'control: the base loop continued past a missing first file');

  // Site 2: ai-w5-recovery-transfer, the box upload check ($1 is the upload).
  const upload = one(block('ai-w5-recovery-transfer'), /^test (?:-f|! -L) "\$upload" \|\|[^\n]*$/gm, 2);
  const real = file('site-recovery.tar');
  reaches(underSetE('upload=$1\n' + upload, {}, [real]), 'site 2 regular');
  stopsWith(underSetE('upload=$1\n' + upload, {}, [join(dir, 'absent.tar')]), 'FAIL ai-w5-recovery-transfer: site-recovery upload expected regular-file got missing-or-other; STOP', 'site 2 first test false');
  stopsWith(underSetE('upload=$1\n' + upload, {}, [link('upload-link.tar', real)]), 'FAIL ai-w5-recovery-transfer: site-recovery upload expected not-symlink got symlink; STOP', 'site 2 second test false');
  const baseUpload = one(baseBlock('ai-w5-recovery-transfer'), /^test -f "\$upload" && test ! -L "\$upload"$/gm, 1);
  reaches(underSetE('upload=$1\n' + baseUpload, {}, [join(dir, 'absent.tar')]), 'control: the base check continued past a missing upload');

  // Site 3: ai-w5-recovery-env, its final assertion (an assertion, not a conditional: nothing branches on it).
  const env = one(block('ai-w5-recovery-env'), /^test "\$(?:WINDOW|CLOSE_RESULT)" = [^\n]*\|\|[^\n]*$/gm, 2);
  reaches(underSetE(env, { WINDOW: 'W5', CLOSE_RESULT: 'recovered' }), 'site 3 W5 recovered');
  stopsWith(underSetE(env, { WINDOW: 'W6', CLOSE_RESULT: 'recovered' }), 'FAIL ai-w5-recovery-env: WINDOW expected W5 got other; STOP', 'site 3 first test false');
  stopsWith(underSetE(env, { WINDOW: 'W5', CLOSE_RESULT: 'success' }), 'FAIL ai-w5-recovery-env: CLOSE_RESULT expected recovered got other; STOP', 'site 3 second test false');

  // Sites 4 and 5: ai-close, the W5 recovered close markers.
  const close = one(block('ai-close'), /^ test ! -[eL] "\$PROOF_DIR\/(?:closed\.txt|close-result\.json)" \|\|[^\n]*$/gm, 4);
  for (const name of ['closed.txt', 'close-result.json']) {
    const proof = realpathSync(mkdtempSync(join(dir, 'proof-')));
    reaches(underSetE(close, { PROOF_DIR: proof }), `${name}: absent`);
    writeFileSync(join(proof, name), 'earlier close\n');
    stopsWith(underSetE(close, { PROOF_DIR: proof }), `FAIL ai-close: W5 ${name} expected absent got present; STOP`, `${name}: first test false`);
    reaches(underSetE(one(baseBlock('ai-close'), /^ test ! -e "\$PROOF_DIR\/(?:closed\.txt|close-result\.json)" && [^\n]*$/gm, 2), { PROOF_DIR: proof }),
      `control: the base close continued past an existing ${name}`);
    spawnSync('/bin/mv', [join(proof, name), join(proof, `${name}.moved`)]);
    symlinkSync(join(proof, 'absent-target'), join(proof, name));
    stopsWith(underSetE(close, { PROOF_DIR: proof }), `FAIL ai-close: W5 ${name} expected not-symlink got symlink; STOP`, `${name}: second test false (dangling link)`);
  }
});

// M15/M16: ai-mac-recovery-env as a complete block in a fresh /bin/bash, /private/tmp/ remapped to a fixture directory.
function macRecovery() {
  const root = realpathSync(mkdtempSync(join(scratch, 'mac-rec-'))), bin = join(root, 'bin'), proof = join(root, 'c1-proof');
  mkdirSync(bin); mkdirSync(proof);
  const source = block('ai-mac-recovery-env');
  assert.equal(source.split('/private/tmp/').length - 1, 2, 'the two /private/tmp/ literals are the only remapped text');
  const remapped = source.split('/private/tmp/').join(root + '/');
  const tar = Buffer.from('mac recovery archive\n');
  const ids = { release_sha: sha, window: 'W6', window_id: 'Rc0v20' };
  const inputs = join(root, 'inputs.json');
  const writeInputs = (change: Record<string, unknown> = {}) => writeFileSync(inputs, JSON.stringify({ archive_sha256: hash(tar), ...ids, ...change }));
  writeInputs();
  const prep = (name: string, binding: Record<string, string> | null, bytes: Buffer = tar) => {
    const p = join(root, `admin-issuance-prep.${name}`); mkdirSync(p, { mode: 0o700 }); chmodSync(p, 0o700);
    writeFileSync(join(p, 'release.tar'), bytes, { mode: 0o600 });
    if (binding) writeFileSync(join(p, 'binding.json'), JSON.stringify(binding, Object.keys(binding).sort()) + '\n', { mode: 0o600 });
    return p;
  };
  // ssh/scp record their arguments; the only remote output modelled is the upload stage name.
  writeFileSync(join(bin, 'ssh'), `#!/bin/bash\nprintf 'ssh %s\\n' "\${@: -1}" >>"$STUB_LOG"\ncase "\${@: -1}" in 'umask 077; mktemp -d /tmp/admin-c1.XXXXXX') printf '/tmp/admin-c1.Abc123\\n';; esac\n`, { mode: 0o700 });
  writeFileSync(join(bin, 'scp'), `#!/bin/bash\nprintf 'scp %s\\n' "\${@: -1}" >>"$STUB_LOG"\n`, { mode: 0o700 });
  const log = join(root, 'stub.log');
  const run = (after = '', withRecovery = true) => spawnSync('/bin/bash', [], {
    input: (withRecovery ? remapped + '\n' : '') + after, encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, INPUTS_FILE: inputs, STUB_LOG: log, C1_TRANSFER_DIRECTION: 'upload', C1_TRANSFER_FILE: 'C1-inputs.json', C1_PROOF_DIR: proof } });
  return { root, ids, inputs, writeInputs, prep, run, tar, proof, log };
}

test('M16 / prep-dir-binding: ai-prepare records the window binding at creation; recovery selects the one matching directory and refuses zero or several', () => {
  // ai-prepare writes binding.json in the new prep directory, before the archive.
  const f = fixture();
  f.put('inputs.json', { ...f.json('inputs.json'), baseline_site_sha: 'c'.repeat(40), window: 'W3', ...Object.fromEntries(['recycle_install_mode', 'recycle_baseline_sha256',
    'keeper_install_receipt_sha256', 'keeper_host', 'keeper_upload_owner', 'keeper_baseline', 'keeper_install_vars_path', 'keeper_install_md_sha256', 'keeper_install_excerpts'].map(k => [k, undefined])) });
  f.put('git-plan.md', planBytes);
  f.fixtureConfig({ git: { rev: { [sha]: sha, ['c'.repeat(12)]: 'c'.repeat(40) }, archive: join(f.root, f.upload), plan: join(f.root, 'git-plan.md') } });
  const prepared = f.run(['ai-prepare'], { PLAN_FILE: join(f.root, 'git-plan.md'), KEEPER_INSTALL_MD_FILE: '' }); pass(prepared, 'ai-prepare');
  const prepDir = /PASS ai-prepare: archive retained at ([^;]+);/.exec(prepared.stdout)![1]!;
  assert.equal(readFileSync(join(prepDir, 'binding.json'), 'utf8'), JSON.stringify({ release_sha: sha, window: 'W3', window_id: wid },['release_sha','window','window_id']) + '\n');
  assert.equal(statSync(join(prepDir, 'binding.json')).mode & 0o777, 0o600);
  const p = block('ai-prepare');
  assert.ok(p.indexOf('binding.json') < p.indexOf('git archive --format=tar'), 'the binding is written when the directory is created');

  // None: a directory with the right archive but no recorded binding (made before M16) is never selected.
  const none = macRecovery(); none.prep('Old001', null);
  const zero = none.run(); assert.notEqual(zero.status, 0); assert.match(zero.stderr, /FAIL ai-mac-recovery-env: PREP_DIR expected one matching-prep-dir got zero; STOP/);
  // Same archive, different windows: the directory whose binding equals INPUTS is selected; a different archive with the right binding is not.
  const m = macRecovery();
  const match = m.prep('Win006', m.ids);
  m.prep('Win007', { ...m.ids, window: 'W7', window_id: 'Oth007' });
  m.prep('Wid006', { ...m.ids, window_id: 'Oth006' });
  m.prep('Tar006', m.ids, Buffer.from('another archive\n'));
  const one = m.run('printf "SELECTED %s\\n" "$PREP_DIR"\n'); pass(one, 'one match');
  assert.match(one.stdout, new RegExp(`^SELECTED ${match.replace(/[.]/g, '\\.')}$`, 'm'));
  // Two for the same window: refuse.
  m.prep('Dup006', m.ids);
  const several = m.run(); assert.notEqual(several.status, 0); assert.match(several.stderr, /PREP_DIR expected one matching-prep-dir got several; STOP/);
});

test('M15 / mac-recovery-window-identity: a fresh Mac shell after ai-mac-recovery-env has RELEASE_SHA and WINDOW_ID from INPUTS and the W6 transfer row runs', () => {
  const m = macRecovery(); m.prep('Win006', m.ids);
  writeFileSync(join(m.proof, 'C1-inputs.json'), '{}\n', { mode: 0o600 });
  // Exported: a child process of the recovered shell sees both values equal to INPUTS.
  const child = m.run(`/bin/bash -c 'printf "CHILD %s %s\\n" "$RELEASE_SHA" "$WINDOW_ID"'\n`); pass(child, 'exported');
  assert.match(child.stdout, new RegExp(`^CHILD ${sha} Rc0v20$`, 'm'));
  // The W6 transfer row runs in that shell and installs into this window's proof directory.
  const transfer = m.run(block('ai-w6-transfer')); pass(transfer, 'W6 transfer after recovery');
  const proofDir = `/home/commonswarm/admin-issuance/release-proofs/${sha}-W6-Rc0v20`;
  assert.ok(readFileSync(m.log, 'utf8').split('\n').some(l => l.startsWith('ssh sudo -n install -o root -g root -m 0600 /tmp/admin-c1.Abc123/C1-inputs.json ' + proofDir + '/C1-inputs.json')),
    readFileSync(m.log, 'utf8'));
  // Control: the same row in a fresh shell without the recovery block stops on the unset identity.
  const bare = m.run(block('ai-w6-transfer'), false); assert.notEqual(bare.status, 0); assert.match(bare.stderr, /RELEASE_SHA: unbound variable/);
  // A malformed value in INPUTS refuses; nothing is exported.
  for (const [change, message] of [[{ release_sha: 'A'.repeat(40) }, 'inputs release_sha expected 40-hex got other'], [{ window_id: 'bad-01' }, 'inputs window_id expected 6-alphanumeric got other'],
    [{ window: 'W8' }, 'inputs window expected W1-W7-or-W2b got other']] as const) {
    m.writeInputs(change);
    const r = m.run(`printf 'LEAKED %s\\n' "\${RELEASE_SHA-unset}"\n`);
    assert.notEqual(r.status, 0, message); assert.ok(r.stderr.includes(`FAIL ai-mac-recovery-env: ${message}; STOP`), r.stderr); assert.doesNotMatch(r.stdout, /LEAKED/);
  }
});

test('MOA / open-abort-refuses-attempt-markers: each window attempt marker in PROOF_DIR refuses the abort; none present passes', () => {
  // Enumerate the markers from the plan itself (git grep 'attempted'), not from a typed list.
  const markers = [...new Set([...plan.matchAll(/[a-z0-9-]+-attempted\.txt/g)].map(m => m[0]))].sort();
  for (const name of ['edge-attempted.txt', 'activation-attempted.txt', 'keeper-retire-attempted.txt', 'edge-oauth-runtime-revoke-attempted.txt',
    'edge-oauth-runtime-grant-attempted.txt', 'issuer-provisioning-attempted.txt', 'oauth-attempted.txt', 'dcr-probe-revoke-attempted.txt'])
    assert.ok(markers.includes(name), `${name} is enumerated`);
  const source = block('ai-open-abort');
  assert.equal(source.split('\n')[2], baseBlock('ai-open-abort').split('\n')[2], 'the host line is byte-identical');
  const tmpNs = realpathSync(mkdtempSync(join(scratch, 'moa-tmp-')));
  assert.equal(source.split("os.listdir('/tmp')").length - 1, 1); assert.equal(source.split("path='/tmp/'+").length - 1, 1);
  const remapped = source.split("os.listdir('/tmp')").join(`os.listdir(${JSON.stringify(tmpNs)})`).split("path='/tmp/'+").join(`path=${JSON.stringify(tmpNs + '/')}+`);
  const abort = (proof: string) => spawnSync('/bin/bash', [], { input: remapped, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', PROOF_DIR: proof } });
  for (const name of markers) for (const shape of ['file', 'dangling link'] as const) {
    const proof = realpathSync(mkdtempSync(join(scratch, 'moa-proof-')));
    if (shape === 'file') writeFileSync(join(proof, name), '2026-10-10T00:00:00Z\n'); else symlinkSync(join(proof, 'absent'), join(proof, name));
    const r = abort(proof);
    refused(r, `FAIL ai-open-abort: window attempt markers expected none got ${name}; a production operation was attempted: use the window rollback and the recovered ai-close; STOP`);
    assert.ok(!existsSync(join(proof, 'aborted-before-mutation.txt')), `${name} (${shape}): no abort record`);
  }
  // A recorded secret stage is left in place when a marker refuses the abort.
  const staged = realpathSync(mkdtempSync(join(scratch, 'moa-proof-'))), stage = join(tmpNs, 'anvil-secret.Moa001');
  mkdirSync(stage, { mode: 0o700 }); writeFileSync(join(staged, 'secret-stage.path'), stage + '\n'); writeFileSync(join(staged, 'edge-attempted.txt'), 'x\n');
  refused(abort(staged), 'got edge-attempted.txt;'); assert.ok(existsSync(stage), 'the stage is not removed');
  // Positive control: no marker passes and records the abort.
  const clean = realpathSync(mkdtempSync(join(scratch, 'moa-proof-')));
  const ok = abort(clean); pass(ok, 'no marker');
  assert.match(ok.stdout, /PASS ai-open-abort: aborted before mutation/); assert.ok(existsSync(join(clean, 'aborted-before-mutation.txt')));
});

test('Fix M1 / rollback freshly measures the baseline; recovered close refuses stale generation and every stale identity', () => {
  const f = fixture(); pass(f.run(forward()), 'forward'); pass(f.run(['ai-w4-rollback']), 'rollback');
  const db = cutover(f), measurement = f.json('proof/w4-rollback-measurement.json');
  assert.equal(db.measured, baseline); assert.equal(db.measured_generation, db.generation);
  assert.equal(db.identities.artifact_digest, f.legacyHash); assert.equal(measurement.source.archive, join(f.root, f.legacy));
  const close = () => f.run(['ai-close'], { CLOSE_RESULT: 'recovered', LIVE_CONTROLS_FILE: join(f.root, 'proof/ordinary-recovery.json') });
  for (const change of [{ measured: sha }, { measured_generation: db.generation - 1 }, { generation: db.generation + 1 },
    { identities: { ...db.identities, target: join(f.root, 'edge/releases', sha) } },
    { identities: { ...db.identities, mount: join(f.root, 'edge/releases', sha) } },
    { identities: { ...db.identities, image_digest: 'sha256:' + 'e'.repeat(64) } },
    { identities: { ...db.identities, artifact_digest: 'e'.repeat(64) } }, { measured_at: null }, { evidence_ref: 'stale' }]) {
    f.put('cutover.json', { ...db, ...change });
    refused(close(), 'CLOSED-invalidated-and-freshly-measured-baseline-at-live-generation');
    assert.ok(!proofHas(f, 'closed.txt'));
  }
  f.put('cutover.json', db); f.fixtureConfig({ mount_drift: true });
  refused(close(), 'measured-baseline-source-readonly'); assert.ok(!proofHas(f, 'closed.txt'));
  f.fixtureConfig({ mount_drift: false }); pass(close(), 'fresh baseline control');
  // A source byte drift reaches the measurement boundary, before SQL is written or the timer re-arm.
  const drift = fixture(); prepared(drift); drift.put(`edge/releases/${baseline}/src/reviewed.txt`, 'drift\n', 0o644);
  refused(drift.run(['ai-w4-rollback']), 'baseline archive/source target mount image expected verified got other');
  assert.ok(!proofHas(drift, 'w4-rollback-measurement.json'));
  drift.put(`edge/releases/${baseline}/src/reviewed.txt`, 'baseline tracked bytes\n', 0o644);
  pass(drift.run(['ai-w4-rollback']), 'source byte control');
});

test('Fix M2 / rollback restages a missing legacy archive, preserves an intact one and refuses unsafe paths or unrelated bytes', () => {
  for (const missing of [false, true]) {
    const f = fixture(); prepared(f); pass(f.run(['ai-w4-keeper-retire']), 'adopt and retire');
    const path = join(f.root, f.legacy), before = statSync(path);
    if (missing) renameSync(path, join(f.root, 'saved-legacy.tar'));
    pass(f.run(['ai-w4-rollback']), missing ? 'missing restaged' : 'intact preserved');
    assert.deepEqual(readFileSync(path), f.legacyBytes); assert.equal(statSync(path).mode & 0o7777, before.mode & 0o7777);
    if (!missing) assert.equal(statSync(path).ino, before.ino, 'intact archive is not replaced');
    pass(f.run(['ai-close'], { CLOSE_RESULT: 'recovered', LIVE_CONTROLS_FILE: join(f.root, 'proof/ordinary-recovery.json') }), 'recovered control');
  }
  for (const kind of ['unrelated', 'symlink', 'durable-byte', 'unsafe-path', 'durable-parent'] as const) {
    const f = fixture(); prepared(f); pass(f.run(['ai-w4-keeper-retire']), 'adopt');
    const legacy = join(f.root, f.legacy), durable = join(f.root, 'var-lib-admin-release/archives', `${baseline}-${legacyWid}.tar`);
    if (kind === 'unrelated') writeFileSync(legacy, 'unrelated bytes\n');
    if (kind === 'symlink') { renameSync(legacy, join(f.root, 'saved-legacy.tar')); symlinkSync(join(f.root, 'saved-legacy.tar'), legacy); }
    if (kind === 'durable-byte') writeFileSync(durable, 'wrong durable bytes\n');
    if (kind === 'durable-parent') chmodSync(dirname(durable), 0o777);
    if (kind === 'unsafe-path') {
      const path = 'proof/w4-state/recycle-baseline.json', r = f.json(path); r.archive.path = join(f.root, 'unrelated.tar');
      const bytes = JSON.stringify(r); f.put(path, bytes); f.put('inputs.json', { ...f.json('inputs.json'), recycle_baseline_sha256: hash(bytes) });
    }
    const result = f.run(['ai-w4-rollback']);
    refused(result, kind === 'unrelated' ? 'unrelated-existing-bytes-or-metadata' : kind === 'symlink' ? 'symlink-or-other' : kind === 'unsafe-path' ? 'unsafe-path' : kind === 'durable-parent' ? 'unsafe-path-or-metadata' : 'admitted-receipt-bytes-root-0600');
    assert.ok(!proofHas(f, 'w4-rollback-measurement.json'), kind);
    if (kind === 'unrelated') assert.equal(readFileSync(legacy, 'utf8'), 'unrelated bytes\n');
  }
});

test('Fix M3 / recovered INTACT refuses load, active and enable drift on every keeper unit, with an unchanged control', () => {
  const f = fixture(); prepared(f); pass(f.run(['ai-w4-rollback']), 'intact rollback');
  const original = units(f);
  const close = () => f.run(['ai-close'], { CLOSE_RESULT: 'recovered', LIVE_CONTROLS_FILE: join(f.root, 'proof/ordinary-recovery.json') });
  for (const u of keeperUnits) for (const [field, value] of [['load', 'not-found'], ['active', original[u].active === 'active' ? 'inactive' : 'active'], ['enabled', 'disabled']]) {
    f.put('units.json', { ...original, [u]: { ...original[u], [field!]: value } });
    refused(close(), 'keeper expected RETIRED-or-INTACT got partial-retirement'); assert.ok(!proofHas(f, 'closed.txt'));
  }
  f.put('units.json', original); pass(close(), 'all three units unchanged');
});

test('Fix M4 / pre-existing temporary files survive refusal; interrupted forward and rollback files recover exactly', () => {
  for (const target of ['libexec/commonswarm-admin-edge-recycle', 'admin-release/recycle.json']) {
    const rel = join(dirname(target), `.${target.split('/').pop()}.${wid}.new`);
    const f = fixture(); f.put(rel, 'pre-existing bytes\n', 0o700); const old = statSync(join(f.root, rel));
    refused(f.run(['ai-w4-preflight']), 'expected absent got present');
    refused(f.run(['ai-w4-rollback']), 'temporary recycle files expected absent-without-admission got present');
    assert.equal(readFileSync(join(f.root, rel), 'utf8'), 'pre-existing bytes\n'); assert.equal(statSync(join(f.root, rel)).ino, old.ino);
    // A file planted after forward completion must also survive rollback refusal, even with a forward receipt.
    const planted = fixture(); pass(planted.run(forward()), 'forward before unrelated temporary file');
    planted.put(rel, 'unrelated bytes\n', 0o700); const plantedInode = statSync(join(planted.root, rel)).ino;
    refused(planted.run(['ai-w4-rollback']), 'exact-window-creation-identity');
    assert.equal(readFileSync(join(planted.root, rel), 'utf8'), 'unrelated bytes\n');
    assert.equal(statSync(join(planted.root, rel)).ino, plantedInode);
    for (const phase of ['forward', 'rollback']) {
      const good = fixture(), before = monitored(good), live = readFileSync(join(good.root, target));
      if (phase === 'rollback') pass(good.run(forward()), 'completed forward control');
      good.fixtureConfig({ interrupt_replace: [target] });
      const interrupted = good.run(phase === 'forward' ? forward() : ['ai-w4-rollback']);
      assert.notEqual(interrupted.status, 0); assert.match(interrupted.stderr, /fixture interruption before rename/);
      const temporary = join(good.root, rel), identity = good.json(`proof/w4-state/${rel.split('/').pop()}.identity.json`);
      assert.equal(identity.ino, statSync(temporary).ino, `${phase} ${target}: receipt records the exclusive creation`);
      good.fixtureConfig({ interrupt_replace: [] }); pass(good.run(['ai-w4-rollback']), `${phase} ${target}: recovery retry`);
      assert.ok(!existsSync(temporary)); assert.deepEqual(readFileSync(join(good.root, target)), live);
      pass(good.run(['ai-close'], { CLOSE_RESULT: 'recovered', LIVE_CONTROLS_FILE: join(good.root, 'proof/ordinary-recovery.json') }), 'recovered close');
      exactRestoration(good, before, monitored(good), { retired: true, promoted: true });
    }
  }
});

test('Fix M5 / config directory admits only a canonical root-owned 0700 path and refuses unsafe metadata before writes and at close', () => {
  for (const kind of ['mode', 'uid', 'gid', 'symlink'] as const) {
    const f = fixture({}, { mode: 'fresh' }), path = join(f.root, 'admin-release');
    if (kind === 'mode') { chmodSync(path, 0o777); f.writeInputs(); }
    if (kind === 'uid' || kind === 'gid') {
      f.fixtureConfig({ owners: { 'admin-release': kind === 'uid' ? [1001, 0] : [0, 1001] } });
      f.writeInputs({}, r => { r.config_dir[kind] = 1001; });
    }
    if (kind === 'symlink') { renameSync(path, path + '.real'); symlinkSync(path + '.real', path); }
    refused(f.run(['ai-w4-preflight']), kind === 'symlink' ? 'unsafe-path' : 'root-0700-directory-or-absent');
    assert.ok(!existsSync(join(f.root, 'proof/w4-state')) && !existsSync(join(f.root, 'edge/releases', sha)), kind);
  }
  const good = fixture({}, { mode: 'fresh' }); pass(good.run([...forward(), 'ai-w4-readback']), 'safe directory');
  const close = () => good.run(['ai-close'], { CLOSE_RESULT: 'success', LIVE_CONTROLS_FILE: join(good.root, 'proof/ordinary-after.json') });
  chmodSync(join(good.root, 'admin-release'), 0o777); refused(close(), 'root-0700-directory');
  chmodSync(join(good.root, 'admin-release'), 0o700); pass(close(), 'safe directory control');
});

test('Fix CI / W4 traps fail closed on missing input even on Bash 3.2; complete fixtures reach the measurement and install', () => {
  const f = fixture(); prepared(f); pass(f.run(['ai-w4-keeper-retire']), 'retired');
  const bad = f.run(['ai-w4-apply'], { NEW_EDGE: '' }); refused(bad, 'NEW_EDGE required');
  assert.ok(!proofHas(f, 'edge-attempted.txt'), 'refused before mutation');
  const good = f.run(['ai-w4-apply']); pass(good, 'all inputs provided');
  assert.ok(proofHas(f, 'edge-measurement.json') && existsSync(join(f.root, 'proof/w4-state/install-after.json')), 'the positive control runs the complete apply');
  const masked = f.run(['# nounset inside the real trap lifetime\n(\nai_run ai-timer-guard\nunset W4_UNSET\nprintf \"%s\\n\" \"$W4_UNSET\"\n)']);
  assert.notEqual(masked.status, 0); assert.match(masked.stderr, /unbound variable/);
  // The actual trap must fail a zero-status, incomplete body, and preserve a completed zero status.
  for (const done of ['0', '1']) {
    const r = f.run(['# trap control\n(\nai_run ai-timer-guard\nW4_BLOCK_DONE=' + done + '\n)']);
    assert.equal(r.status, done === '1' ? 0 : 1, r.stderr);
  }
});


test('Fix ruling 25 / admin recovery read inventory is generated from C and its callers; an unlisted read refuses', () => {
  // SQL enforces the resource set; the shared client contract must agree with it.
  const sql = readFileSync('supabase/functions/read/admin-recovery.sql', 'utf8');
  const fn = sql.match(/CREATE OR REPLACE FUNCTION (\w+\.\w+)\(/)![1]!;
  const resources = [...sql.match(/p_resource NOT IN \(([^)]+)\)/)![1]!.matchAll(/'([^']+)'/g)].map(m => m[1]!);
  assert.ok(resources.length > 0);
  assert.deepEqual([...ADMIN_READ_RESOURCES].sort(), [...resources].sort(), 'client resources reconcile with SQL enforcement');
  const cli = readFileSync('src/cli.ts', 'utf8');
  const verbs = [...cli.matchAll(/^\s*(\w+): commandEntry\(.*handler: runAdminRead,/gm)].map(m => m[1]!);
  assert.ok(verbs.length > 0);
  const call = new RegExp(`(?:(?:["']resource["']|\\bresource)\\s*[:=]\\s*["'](?:${resources.join('|')})["']|\\badmin\\s+(?:${verbs.join('|')})\\b|\\b(?:readAdminDelegations|readAdminRecovery)\\s*\\(|${fn.replaceAll('.', '\\.')})`);
  const tracked = spawnSync('git', ['ls-files', '*.mjs'], { encoding: 'utf8' });
  assert.equal(tracked.status, 0, tracked.stderr);
  const scriptPaths = tracked.stdout.trim().split('\n');
  const executable = (source: string) => source.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  // C calls node directly (shell/Python), or authenticates the released external producer with getmember.
  // Resolve release prefixes and $MIGRATE from the tracked suffix, refusing missing/ambiguous paths.
  const callers = (source: string, overrides: Map<string, string>) => {
    const paths = new Set<string>();
    for (const line of executable(source).split('\n')) {
      if (!/\bnode\b|\.getmember\(/.test(line)) continue;
      for (const m of line.matchAll(/[A-Za-z0-9_./-]+\.mjs\b/g)) {
        const suffix = m.index! > 0 && line[m.index! - 1] === '$'
          ? m[0].slice(m[0].indexOf('/') + 1) : m[0].replace(/^\/+/, '');
        const all = [...new Set([...scriptPaths, ...overrides.keys()])];
        let matches = all.filter(path => suffix === path || suffix.endsWith('/' + path));
        if (matches.length === 0) matches = all.filter(path => path === suffix || path.endsWith('/' + suffix));
        assert.equal(matches.length, 1, `one released script for executable C reference ${suffix}`);
        paths.add(matches[0]!);
      }
    }
    return [...paths].sort();
  };
  const reads = (path: string, overrides: Map<string, string>, seen = new Set<string>()): boolean => {
    if (seen.has(path)) return false;
    seen.add(path);
    const source = overrides.get(path) ?? readFileSync(path, 'utf8');
    if (call.test(source)) return true;
    // Also follow a called helper's relative imports; built-in modules do not reach the recovery read.
    return [...source.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+\.mjs)['"]/g)]
      .some(m => reads(relative(process.cwd(), resolve(dirname(path), m[1]!)), overrides, seen));
  };
  const inventory = (source: string, overrides = new Map<string, string>()) => blocksOf(source)
    .filter(b => call.test(executable(b)) || callers(b, overrides).some(path => reads(path, overrides)))
    .map(b => b.split('\n')[0]!.slice('# step: '.length)).sort();
  const gate = (source: string, overrides = new Map<string, string>()) => {
    const record = JSON.parse(source.match(/^\{"admin_recovery_read_steps":.*\}$/m)![0]);
    assert.deepEqual(inventory(source, overrides), record.admin_recovery_read_steps, 'unlisted admin recovery read step');
  };
  const external = [...new Set(blocksOf(plan).flatMap(b => callers(b, new Map())))].sort();
  assert.equal(external.length, 3, `external script set reconciles: ${JSON.stringify(external)}`);
  for (const path of external) assert.equal(reads(path, new Map()), false, `${path} has no recovery read`);
  const recovery = cli.slice(cli.indexOf('async function runAdminRecovery('), cli.indexOf('const page = await readAdminDelegations'));
  assert.match(recovery, /if \(grantId !== null\) \{[\s\S]*revokeAdminDelegation[\s\S]*return;\n  \}/, 'revoke returns before the read path');
  const addStep = (body: string) => plan + `\n\`\`\`sh\n# step: ai-new-owner-read\n# readonly: yes\n# host: box root\n${body}\n\`\`\`\n`;
  gate(plan); // Unchanged-plan positive control reaches the exact same gate as each injection.
  for (const verb of verbs) {
    assert.throws(() => gate(addStep(`node --import tsx src/cli.ts admin ${verb} --limit 1 --json`)), /unlisted admin recovery read step/);
    gate(plan);
  }
  for (const resource of resources) for (const quote of ['"', "'"]) {
    const body = quote === '"'
      ? `curl --fail --request POST --header @"$SECRET_STAGE/owner-read.headers" --header 'Content-Type: application/json' --data '{"resource":"${resource}","workspace_id":null,"limit":1,"before":null}' https://api.commonswarm.com/functions/v1/read`
      : `python3 - <<'PY'\nimport json,urllib.request\nbody={'resource':'${resource}','workspace_id':None,'limit':1,'before':None}\nurllib.request.urlopen(urllib.request.Request('https://api.commonswarm.com/functions/v1/read',data=json.dumps(body).encode(),headers={'Content-Type':'application/json'},method='POST'))\nPY`;
    assert.throws(() => gate(addStep(body)), /unlisted admin recovery read step/);
    gate(plan);
    // An existing released helper acquiring a quoted read must add all C steps that call it.
    const changed = new Map([[external[0]!, readFileSync(external[0]!, 'utf8') + `\nawait fetch('https://api.commonswarm.com/functions/v1/read', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({${quote}resource${quote}:${quote}${resource}${quote},workspace_id:null,limit:1,before:null})});`]]);
    assert.throws(() => gate(plan, changed), /unlisted admin recovery read step/);
    gate(plan);
  }
  const helper = 'scripts/injected-owner-read.mjs';
  const helperBody = `await fetch('https://api.commonswarm.com/functions/v1/read', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({"resource":"${resources[0]}","workspace_id":null,"limit":1,"before":null})});`;
  assert.throws(() => gate(addStep(`node ${helper}`), new Map([[helper, helperBody]])), /unlisted admin recovery read step/);
  gate(plan);
  // Exact appended block from review B's INJECTED-READ-RELEASE.md, retained without a machine-local dependency.
  const reviewerInjection = addStep(`curl --fail --request POST --header @"$SECRET_STAGE/owner-read.headers" --header 'Content-Type: application/json' --data '{"resource":"admin_grants","workspace_id":null,"limit":1,"before":null}' https://api.commonswarm.com/functions/v1/read`);
  assert.throws(() => gate(reviewerInjection), /unlisted admin recovery read step/);
  gate(plan);
});

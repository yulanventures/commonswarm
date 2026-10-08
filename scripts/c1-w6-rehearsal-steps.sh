# C1 W4/W6/W7 database rehearsal: SOURCED by scripts/c1-w2-rehearsal.sh --w6 after its --from-post-w2 --issuer
# flow (the W2b issuer credential), on the same disposable cluster. It reuses that script's helpers: pgx, ai_db and
# ai_ro (the box psql emulation), extract (plan slices by unique anchors), step, say, die. Bash 3.2-safe.
#
# Plan bytes. The box blocks name box paths (/etc/commonswarm-admin-release, /home/commonswarm, the hook in
# /usr/local/libexec, /tmp/anvil-secret stages, /tmp/admin-issuance-* archives; Mac blocks keep
# /private/tmp/anvil-secret) and the hook requires a root-owned recycle.json. The rehearsal runs a plan COPY
# with exactly those prefixes (and the hook's st_uid==0) mapped into its own mktemp directory; the REMAP line
# lists every substitution with its count, and the reverse map must restore the plan bytes exactly. INPUTS
# plan_sha256 is the copy's digest, so verified_plan accepts it. /private/tmp/anvil-secret is remapped first so
# /tmp/anvil-secret cannot rewrite it as a suffix. Darwin /tmp is a symlink to /private/tmp; without the box
# remap, p.resolve()==p in the edge-receipt query cleanup fails and the W4 measurement STOP looks like a missing row.
# Every slice comes from that copy by unique anchors; nothing is retyped.
#
# External commands are stubs on PATH, in the W6 root only: systemctl (a state file), docker (inspect returns the
# modelled edge container; run --entrypoint psql runs LOCAL psql as the cluster superuser, which then runs the
# plan's own SET LOCAL ROLE statements) and node (make-pg-service writes empty service/pass files). At the
# database boundary (that psql and the ai_db/ai_ro emulation) the rehearsal root maps back to /home/commonswarm in
# SQL and forward in rows: the database holds the box paths, as admin_cutover_state's CHECK requires. The OAuth
# server's consent/issuance rows, the owner commands and the human revoke are EMULATED with the SQL their code
# paths run (supabase/functions/command/admin-delegation.ts persistEvents and the approval statements;
# supabase/functions/_shared/admin-oauth-db.ts record_admin_request_audit), under the same database roles.
# Network probes, Caddy, compose and the Mac blocks are not run and print EMUL lines.

W6R=$T/w6
mkdir -p "$W6R/bin" "$W6R/etc" "$W6R/secret" "$W6R/libexec" "$W6R/tmp" "$W6R/home" || die w6-setup 'cannot create the W6 fixture root'
chmod 0700 "$W6R/etc" "$W6R/secret" || die w6-setup 'chmod failed'
REAL_NODE=$(command -v node) || die w6-setup 'node expected present got missing'
PLANC=$W6R/RELEASE.md
# Test control: C1_W6_PLAN_FROM=<sha> rehearses the W4/W6/W7 blocks of the plan at that commit instead.
W6_PLAN_SRC=$PLAN
if test -n "${C1_W6_PLAN_FROM:-}"; then
  [[ "$C1_W6_PLAN_FROM" =~ ^[0-9a-f]{7,40}$ ]] || die w6-plan-from 'expected a hex commit id'
  git -C "$REPO" show "$C1_W6_PLAN_FROM:$PLAN_REL" >"$W6R/plan-from.md" 2>/dev/null || die w6-plan-from "plan at $C1_W6_PLAN_FROM not readable"
  W6_PLAN_SRC=$W6R/plan-from.md
  say "CONTROL w6-plan-from: W4/W6/W7 blocks from the plan at $C1_W6_PLAN_FROM"
fi
if test "${C1_W2_REHEARSAL_FAULT:-}" = one-statement-close; then
  # Test control: the open-state close as ONE update (generation bump with the close), as before this fix.
  python3 - "$W6_PLAN_SRC" "$W6R/plan-fault.md" <<'PY' || die fault 'two-statement close expected three times got other'
import sys
s=open(sys.argv[1],encoding='utf-8',newline='').read()
new='admin_issuance_enabled=false WHERE singleton; UPDATE commonswarm_oauth.admin_cutover_state SET invalidated_at=statement_timestamp(),release_generation=release_generation+1'
assert s.count(new)==3
open(sys.argv[2],'w',encoding='utf-8',newline='').write(s.replace(new,'admin_issuance_enabled=false,invalidated_at=statement_timestamp(),release_generation=release_generation+1'))
PY
  W6_PLAN_SRC=$W6R/plan-fault.md
  say "FAULT injected: ai-recycle-hook before/close and ai-w6-activation-rollback close and bump the generation in one update (test control)"
fi
python3 - "$W6_PLAN_SRC" "$PLANC" "$W6R" <<'PY' || die w6-plan-copy 'remapped plan copy could not be made or verified'
import re,sys
src,dst,root=sys.argv[1:4]
raw=open(src,encoding='utf-8',newline='').read()
subs=[('/private/tmp/anvil-secret',root+'/secret/mac-anvil-secret'),('/tmp/anvil-secret',root+'/secret/anvil-secret'),('/etc/commonswarm-admin-release',root+'/etc'),
      ('/usr/local/libexec/commonswarm-admin-edge-recycle',root+'/libexec/commonswarm-admin-edge-recycle'),
      ('/home/commonswarm',root+'/home'),('/tmp/admin-issuance-',root+'/tmp/admin-issuance-'),('/var/lib/commonswarm-release',root+'/var-lib'),('/var/backups/commonswarm-postgres',root+'/backups'),
      ('path.stat().st_uid==0','path.stat().st_uid==os.getuid()')]
count={a:raw.count(a) for a,_ in subs}
# The closed-issuance marker path exists only from 04d09c3d on; box /tmp/anvil-secret exists only after C1-12;
# a C1_W6_PLAN_FROM control may lack either.
optional=('path.stat().st_uid==0','/var/lib/commonswarm-release','/tmp/anvil-secret')
assert count['path.stat().st_uid==0']==1 and all(v for k,v in count.items() if k not in optional[1:])
forward=dict(subs); inverse={b:a for a,b in subs}
assert not any(b in raw for b in inverse)
out=re.compile('|'.join(re.escape(a) for a,_ in subs)).sub(lambda m:forward[m.group(0)],raw)
back=re.compile('|'.join(re.escape(b) for b in sorted(inverse,key=len,reverse=True))).sub(lambda m:inverse[m.group(0)],out)
assert back==raw
open(dst,'w',encoding='utf-8',newline='').write(out)
print('REMAP plan copy: '+'; '.join(a+' -> '+b.replace(root,'<w6>')+' x'+str(count[a]) for a,b in subs)+'; the reverse map restores the plan bytes exactly')
PY

# ---- fixture: edge release tree and archive, recycle.json, INPUTS, modelled container ----
W4_ID=W4rhs1 W6_ID=W6rhs1 W7_ID=W7rhs1
python3 - "$W6R" "$RELEASE_SHA" "$PLANC" "$W4_ID" "$W6_ID" "$W7_ID" <<'PY' || die w6-fixture 'fixture files could not be written'
import datetime,hashlib,io,json,os,pathlib,sys,tarfile
root,sha,planc,w4,w6,w7=sys.argv[1:7]; root=pathlib.Path(root)
target=root/'home/edge/releases'/sha
files={'deploy/edge-runtime/main/index.ts':b'// c1 w6 rehearsal edge main\n','supabase/functions/command/index.ts':b'// rehearsal function source\n','src/index.ts':b'// rehearsal src\n'}
buf=io.BytesIO()
with tarfile.open(fileobj=buf,mode='w',format=tarfile.PAX_FORMAT) as t:
    for name,data in sorted(files.items()):
        info=tarfile.TarInfo(name); info.size=len(data); info.mode=0o644; info.mtime=0; t.addfile(info,io.BytesIO(data))
        (target/name).parent.mkdir(parents=True,exist_ok=True); (target/name).write_bytes(data)
tar=buf.getvalue(); digest=hashlib.sha256(tar).hexdigest()
for wid in (w4,w6): (root/('tmp/admin-issuance-'+sha+'-'+wid+'.tar')).write_bytes(tar)
os.symlink(str(target),str(root/'home/edge/current'))
(root/'home/oauth/releases'/sha).mkdir(parents=True); os.symlink(str(root/'home/oauth/releases'/sha),str(root/'home/oauth/current'))
release_root=root/'home/admin-issuance/releases'/sha; (release_root/'deploy/supabase-stack/migrate').mkdir(parents=True)
image='sha256:'+hashlib.sha256(b'c1 w6 rehearsal edge image').hexdigest(); pg='sha256:'+hashlib.sha256(b'c1 w6 rehearsal postgres image').hexdigest()
recycle={'release_sha':sha,'target':str(target),'image_digest':image,'artifact_digest':digest,
         'archive':str(root/('tmp/admin-issuance-'+sha+'-'+w4+'.tar')),'release_root':str(release_root),'postgres_image':pg}
fd=os.open(str(root/'etc/recycle.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f: f.write(json.dumps(recycle,sort_keys=True)+'\n')
def container(img):
    return [{'Image':img,'State':{'Health':{'Status':'healthy'}},'Config':{'Labels':{'com.docker.compose.project.working_dir':str(target/'deploy/edge-runtime')}},
             'HostConfig':{'NetworkMode':'commonswarm-net','Memory':2147483648},
             'Mounts':[{'Destination':d,'Source':str(target/s),'RW':False} for d,s in [('/home/deno/main','deploy/edge-runtime/main'),('/home/deno/functions-source','supabase/functions'),('/var/src','src')]]}]
(root/'container.json').write_text(json.dumps(container(image)))
(root/'container-bad.json').write_text(json.dumps(container('sha256:'+'0'*64)))
plan_sha=hashlib.sha256(pathlib.Path(planc).read_bytes()).hexdigest()
end=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=80)).strftime('%Y-%m-%dT%H:%M:%SZ')
gate=hashlib.sha256(b'c1 w6 rehearsal gate receipt (not a real receipt)').hexdigest()
def inputs(window,wid,**extra):
    d={'release_sha':sha,'plan_sha256':plan_sha,'archive_sha256':digest,'window':window,'window_id':wid,'window_end_utc':end,
       'baseline_edge_image':image,'baseline_postgres_image':pg,'baseline_site_sha':sha,'gate_receipt_sha256':gate,
       'edge_recycle_service':'rehearsal-edge-recycle.service','edge_recycle_timer':'rehearsal-edge-recycle.timer'}
    d.update(extra); return d
for name,d in [('inputs-W4.json',inputs('W4',w4)),('inputs-W6.json',inputs('W6',w6,w2b_release_sha='d'*40,w2b_window_id='W2brh1',keep_open=False)),
               ('inputs-W6-keep.json',inputs('W6',w6,w2b_release_sha='d'*40,w2b_window_id='W2brh1',keep_open=True)),('inputs-W7.json',inputs('W7',w7,w6_window_id=w6)),
               ('inputs-W7-other.json',inputs('W7',w7,w6_window_id='W6zzz9'))]:
    (root/name).write_text(json.dumps(d,sort_keys=True)+'\n')
PY
printf 'active' >"$W6R/timer"; printf 'good' >"$W6R/docker-mode"; printf ok >"$W6R/logger-mode"; : >"$W6R/calls"
python3 - "$W6R" "$PG_BIN" "$T" "$PORT" <<'PY' || die w6-stubs 'stubs could not be written'
import os,pathlib,shlex,sys
root,pg,t,port=sys.argv[1:5]; q=shlex.quote; assert '#' not in root and ' ' not in root; b=pathlib.Path(root)/'bin'
def stub(name,body):
    p=b/name; p.write_text('#!/bin/bash\n# c1 W6 rehearsal stub (test fixture), never a real '+name+'\n'+body); p.chmod(0o700)
stub('systemctl',"printf 'systemctl %s\\n' \"$*\" >>"+q(root+'/calls')+"\ncase \"$1\" in\n stop) printf inactive >"+q(root+'/timer')+" ;;\n start) test ! -e "+q(root+'/timer-start-fails')+" || exit 1; printf active >"+q(root+'/timer')+" ;;\n is-active) test \"$(cat "+q(root+'/timer')+")\" = active ;;\n show) printf 'inactive\\n' ;;\n *) exit 64 ;;\nesac\n")
DOCKER_TEMPLATE=r"""printf 'docker %s\n' "$1" >>@ROOT@/calls
mode=$(cat @ROOT@/docker-mode)
case "$1" in
 inspect)
  if test "$2" = --format; then printf 'healthy\n'; exit 0; fi
  if test "$mode" = bad-image; then exec cat @ROOT@/container-bad.json; fi
  exec cat @ROOT@/container.json ;;
 run)
  # The box's docker run has no -i: the container never sees stdin (modelled with </dev/null below). Read-only file
  # volumes map back to their host files; box paths in SQL map to the box namespace (the table CHECK pins them).
  shift; vols=
  while test $# -gt 0; do
   case "$1" in --volume) vols="$vols
$2"; shift 2 ;; --entrypoint) shift 3; break ;; --rm) shift ;; --network|--add-host|--env) shift 2 ;; *) exit 64 ;; esac
  done
  set -o pipefail; args=(); prev=; sqlfile=
  for a in "$@"; do
   if test "$prev" = --file && test "$a" != -; then
    while IFS= read -r v; do test -n "$v" || continue; src=${v%%:*}; dst=${v#*:}; dst=${dst%%:*}; test "$a" != "$dst" || a=$src; done <<EOF_VOLUMES
$vols
EOF_VOLUMES
    sqlfile=$(mktemp @ROOT@/stmt.XXXXXX) || exit 70
    sed "s#@ROOT@/home#/home/commonswarm#g" "$a" >"$sqlfile" || exit 70
    a=$sqlfile
   fi
   args+=("$a"); prev=$a
  done
  sql=; test -z "$sqlfile" || sql=$(cat "$sqlfile")
  if test -z "$sqlfile" && test "$mode" = query-fails; then exit 1; fi
  # Modelled faults: a reopen that COMMITS but whose response is lost; and a refused release-role close.
  case "$mode:$sql" in lose-reopen-and-close:*'release_generation=release_generation+1 WHERE singleton; COMMIT;'*) exit 1;; esac
  @PG@/psql -h @T@ -p @PORT@ -U supabase_admin -d postgres "${args[@]}" </dev/null | sed "s#/home/commonswarm#@ROOT@/home#g" || exit $?
  case "$mode:$sql" in lose-reopen-*:*'admin_issuance_enabled=true WHERE singleton'*) exit 1;; esac
  exit 0 ;;
esac
exit 64
"""
stub('docker',DOCKER_TEMPLATE.replace('@ROOT@',root).replace('@PG@',pg).replace('@T@',t).replace('@PORT@',port))
stub('logger',"test \"$(cat "+q(root+'/logger-mode')+")\" = ok || exit 1\nprintf '%s\\n' \"${@: -1}\" >>"+q(root+'/journal.log')+"\n")
stub('node',': >"$PG_SERVICE_OUTPUT"; : >"$PG_PASS_OUTPUT"\n')
PY
PATH=$W6R/bin:$PATH; export PATH
# ai_db/ai_ro at the database boundary: SQL text maps the rehearsal root back to /home/commonswarm and rows map it
# forward, so the database stores the box paths its admin_cutover_state CHECK requires.
W6_BOX_ROOT=$W6R/home
eval "ai_db_base() $(declare -f ai_db | sed 1d)"
ai_db() {
  local args=() prev= a n
  for a in "$@"; do
    if test "$prev" = --file && test "$a" != -; then
      case "$a" in /proof/*) n=$PROOF_DIR/.box-paths-$RANDOM$RANDOM.sql
        sed "s#$W6_BOX_ROOT#/home/commonswarm#g" "$PROOF_DIR${a#/proof}" >"$n" || return 1; a=/proof/${n##*/} ;; esac
    elif test "$prev" = --command; then a=$(printf '%s' "$a" | sed "s#$W6_BOX_ROOT#/home/commonswarm#g")
    fi
    args+=("$a"); prev=$a
  done
  ai_db_base "${args[@]}" | sed "s#/home/commonswarm#$W6_BOX_ROOT#g"
  return "${PIPESTATUS[0]}"
}
extract "$PLANC" ai-recycle-hook block >"$T/blocks/w6-recycle-hook.sh"
{ printf '#!/bin/bash\n'; cat "$T/blocks/w6-recycle-hook.sh"; } >"$W6R/libexec/commonswarm-admin-edge-recycle" || die w6-hook 'hook install failed'
chmod 0700 "$W6R/libexec/commonswarm-admin-edge-recycle"
say "EMUL w6-fixture: edge release tree, archive (W4 and W6 names, same bytes), root-owned recycle.json modelled as owner-only 0600, modelled edge container; stubs systemctl/docker/node on PATH; docker psql runs as the cluster superuser"

W4_PROOF=$T/proof-W4 W6_PROOF=$T/proof-W6 W6K_PROOF=$T/proof-W6-keep W7_PROOF=$T/proof-W7
mkdir -p "$W4_PROOF" "$W6_PROOF" "$W6K_PROOF" "$W7_PROOF" || exit 1
TARGET_EDGE=$W6R/home/edge/releases/$RELEASE_SHA
W4_INPUTS=$W6R/inputs-W4.json W6_INPUTS=$W6R/inputs-W6.json W6K_INPUTS=$W6R/inputs-W6-keep.json W7_INPUTS=$W6R/inputs-W7.json
export PLAN_FILE=$PLANC RELEASE_SHA
EDGE_RECYCLE_TIMER=rehearsal-edge-recycle.timer EDGE_RECYCLE_SERVICE=rehearsal-edge-recycle.service
HOOK=$W6R/libexec/commonswarm-admin-edge-recycle
x() { extract "$PLANC" "$@"; }
MARKER=$W6R/var-lib/admin-issuance-closed.log JOURNAL=$W6R/journal.log
marker_count() { if test -f "$MARKER"; then wc -l <"$MARKER" | tr -d ' '; else printf 0; fi; }
# The last marker line: exact keys, event, this release, the unit and reason given; journal holds the same line.
marker_last() { # unit reason
  python3 - "$MARKER" "$JOURNAL" "$RELEASE_SHA" "$1" "$2" <<'PY'
import json,os,re,stat,sys
marker,journal,sha,unit,reason=sys.argv[1:6]
line=open(marker).read().splitlines()[-1]; m=json.loads(line)
assert sorted(m)==['approved_edge_release_sha','at','event','measured_edge_release_sha','reason','unit'], sorted(m)
assert re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ',m['at']) and m['event']=='admin-issuance-closed-needs-reactivation'
assert m['approved_edge_release_sha']==sha and m['measured_edge_release_sha'] is None and m['unit']==unit and m['reason']==reason, m
assert stat.S_IMODE(os.stat(marker).st_mode)==0o644 and open(journal).read().splitlines()[-1]==line
assert not re.search(r'pass|token|secret|postgres(ql)?://',line,re.I)
PY
}

# Negative control: the command must fail and its output or psql log must show the expected refusal.
expect_fail() { # label script pattern
  : >"$SECRET_STAGE/psql.log"
  ( set -euo pipefail; eval "$(cat "$2")" ) >"$T/neg.out" 2>"$T/neg.err"
  local status=$? hit
  NEG_STATUS=$status
  if test "$status" = 0; then say "FAIL $1: refusal expected got success"; exit 1; fi
  hit=$(grep -hoE "$3" "$T/neg.out" "$T/neg.err" "$SECRET_STAGE/psql.log" 2>/dev/null | head -1)
  if test -n "$hit"; then say "PASS $1: refused ($hit)"; return 0; fi
  say "FAIL $1: refusal /$3/ expected got $(first_error "$T/neg.err")"; exit 1
}
q1() { pgx -Atq -v ON_ERROR_STOP=1 -c "$1" 2>"$PSQL_LOG"; }
state() { q1 "SELECT admin_issuance_enabled::text||' gen='||release_generation||' measured='||coalesce(measured_generation::text,'null')||' invalidated='||(invalidated_at IS NOT NULL)::text FROM commonswarm_oauth.admin_cutover_state WHERE singleton;"; }
timer_active() { test "$(cat "$W6R/timer")" = active; }
edge_oauth_membership() {
  q1 "SELECT count(*) FROM pg_auth_members WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole;"
}
w6_edge_grant() { # proof_dir
  test -f "$T/blocks/w6-edge-grant.sh" || return 0
  PROOF_DIR=$1 WINDOW=W6 step ai-w6-edge-oauth-runtime-grant "$T/blocks/w6-edge-grant.sh"
  # step captures stderr; publish only the grant's fixed EMUL notices in the rehearsal report.
  grep '^EMUL ai-w6-edge-oauth-runtime-grant: ' "$T/step.err"
}
w6_edge_revoke() { # proof_dir
  test -f "$T/blocks/w6-edge-revoke.sh" || return 0
  PROOF_DIR=$1 WINDOW=W6 step ai-w6-edge-oauth-runtime-revoke "$T/blocks/w6-edge-revoke.sh"
  test "$(edge_oauth_membership)" = 0 || die ai-w6-edge-oauth-runtime-revoke 'zero membership rows expected after revoke got other'
}

# W6 ai_run: the plan's ai_run evaluates the verified block; the rehearsal evaluates the same block bytes from the
# copy. Blocks that need ingress, compose or gates the rehearsal does not have are EMULATED and say so.
x ai-edge-remeasure block >"$T/blocks/w6-ai-edge-remeasure.sh"
x ai-edge-receipt block >"$T/blocks/w6-ai-edge-receipt.sh"
x ai-w7-preflight block >"$T/blocks/w6-ai-w7-preflight.sh"
x ai-w4-timer-recovery block >"$T/blocks/w6-ai-w4-timer-recovery.sh"
# The rollback's own subshell and re-arm trap, its DB close, then its readback and timer tail; env/compose omitted.
x ai-w6-activation-rollback block >"$T/blocks/w6-rollback-full.sh"
if test "$(sed -n 4p "$T/blocks/w6-rollback-full.sh")" = '(' && grep -qx 'w6_rollback_exit() {' "$T/blocks/w6-rollback-full.sh"; then
  { sed -n 4p "$T/blocks/w6-rollback-full.sh"
    x ai-w6-activation-rollback lines 'w6_rollback_exit() {' 'OAUTH_TARGET=$(readlink -f '
    x ai-w6-activation-rollback from "test \"\$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL"; } >"$T/blocks/w6-rollback-db.sh"
else # a C1_W6_PLAN_FROM plan before the rollback had its own subshell
  { x ai-w6-activation-rollback line 'ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE'
    x ai-w6-activation-rollback from "test \"\$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL"; } >"$T/blocks/w6-rollback-db.sh"
fi
grep -q '^FAIL' "$T/blocks/w6-rollback-db.sh" && die w6-extract "$(grep -m1 '^FAIL' "$T/blocks/w6-rollback-db.sh")"
ai_run() {
  case "$1" in
    ai-edge-remeasure|ai-edge-receipt|ai-w7-preflight|ai-w4-timer-recovery) eval "$(cat "$T/blocks/w6-$1.sh")" ;;
    ai-w6-activation-rollback)
      printf 'EMUL ai-w6-activation-rollback: oauth env/overlay removal and compose recreate not run; DB close and timer re-arm run\n' >&2
      eval "$(cat "$T/blocks/w6-rollback-db.sh")" ;;
    ai-inputs|ai-gates|ai-w7-approval|ai-w6-activation-probes|ai-w6-closed-gate-probe) printf 'EMUL %s: not run in the database rehearsal\n' "$1" >&2 ;;
    *) printf 'FAIL rehearsal ai_run: %s is not dispatched\n' "$1" >&2; return 1 ;;
  esac
}
# C1-37: SET grant after ai-db-session and before prepare/activation. Catalog GRANT/readback/refusals
# run; edge-login file preparation and the docker live SET LOCAL ROLE proof are EMULATED.
if grep -q '^# step: ai-w6-edge-oauth-runtime-grant$' "$PLANC"; then
  x ai-w6-edge-oauth-runtime-grant lines 'test "$WINDOW" = W6' 'cat >"$PROOF_DIR/edge-oauth-runtime-live.sql"' >"$T/blocks/w6-edge-grant-prefix.sh"
  # Match the preparation's own refusal text, so an earlier python invocation stays in the slice.
  EDGE_LOGIN_PREP='edge-login files from SWARM_DATABASE_URL expected prepared got refused'
  { if grep -Fq "$EDGE_LOGIN_PREP" "$T/blocks/w6-edge-grant-prefix.sh"; then
      x ai-w6-edge-oauth-runtime-grant lines 'test "$WINDOW" = W6' "$EDGE_LOGIN_PREP"
      printf '%s\n' 'printf "EMUL ai-w6-edge-oauth-runtime-grant: edge-login file preparation not run (production SWARM_DATABASE_URL is not read)\n" >&2'
      x ai-w6-edge-oauth-runtime-grant lines 'if test -f "$PROOF_DIR/edge-oauth-runtime-grant.txt"' 'cat >"$PROOF_DIR/edge-oauth-runtime-live.sql"'
    else # historical C1_W6_PLAN_FROM controls prepared edge-login files after the live.sql anchor
      cat "$T/blocks/w6-edge-grant-prefix.sh"
      printf '%s\n' 'printf "EMUL ai-w6-edge-oauth-runtime-grant: edge-login file preparation not run (production SWARM_DATABASE_URL is not read)\n" >&2'
    fi
    printf '%s\n' 'printf "EMUL ai-w6-edge-oauth-runtime-grant: live edge-login proof not run (docker SET LOCAL ROLE as commonswarm_edge is not modelled); catalog GRANT, refusals and readback ran\n" >&2'
    x ai-w6-edge-oauth-runtime-grant from 'printf '\''%s\n'\'' "$GRANT_PASS" >"$PROOF_DIR/edge-oauth-runtime-grant.txt"'; } >"$T/blocks/w6-edge-grant.sh"
fi
if grep -q '^# step: ai-w6-edge-oauth-runtime-revoke$' "$PLANC"; then
  x ai-w6-edge-oauth-runtime-revoke block >"$T/blocks/w6-edge-revoke.sh"
fi
for f in "$T"/blocks/w6-*.sh; do /bin/bash -n "$f" || die w6-extract "$(basename "$f") is not valid bash"; done

# ---------------- W4: issuance close, legacy fence, measurement ----------------
x ai-w4-apply lines 'ai_db -q --command "BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false' 'date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/edge-attempted.txt"' >"$T/blocks/w4-close.sh"
x ai-w4-apply lines 'python3 - "$NEW_EDGE" "$INPUTS_FILE" "$PROOF_DIR/edge-measurement.json" <<' '# Separate terminal-fence approval' >"$T/blocks/w4-edge-measurement.sh"
x ai-w4-apply lines 'python3 - "$PROOF_DIR" "$RELEASE_ROOT" "$RELEASE_SHA" "$WINDOW_ID" <<' 'cmp -s /etc/caddy/sites/20-commonswarm-mcp.caddy' >"$T/blocks/w4-measure.sh"
x ai-w4-readback lines "test \"\$(ai_ro -Atq --command 'SELECT NOT admin_issuance_enabled AND legacy_closed" "printf 'PASS closure/measurement" >"$T/blocks/w4-readback.sh"
for f in "$T"/blocks/w4-*.sh; do /bin/bash -n "$f" || die w6-extract "$(basename "$f") is not valid bash"; done
LEGACY_BEFORE=$(q1 "SELECT legacy_closed FROM commonswarm_oauth.admin_cutover_state WHERE singleton;") || die w4 "$(first_error "$PSQL_LOG")"
test "$LEGACY_BEFORE" = f || die w4 "legacy_closed expected false before W4 got $LEGACY_BEFORE"
PROOF_DIR=$W4_PROOF INPUTS_FILE=$W4_INPUTS step ai-w4-apply:issuance-close "$T/blocks/w4-close.sh"
say "EMUL ai-w4-apply: backup gate, timer guard, edge switch, compose and Caddy not run"
PROOF_DIR=$W4_PROOF INPUTS_FILE=$W4_INPUTS NEW_EDGE=$TARGET_EDGE step ai-w4-apply:edge-measurement "$T/blocks/w4-edge-measurement.sh"
PROOF_DIR=$W4_PROOF INPUTS_FILE=$W4_INPUTS WINDOW_ID=$W4_ID step ai-w4-apply:legacy-fence-and-measure "$T/blocks/w4-measure.sh"
PROOF_DIR=$W4_PROOF step ai-w4-readback "$T/blocks/w4-readback.sh"
test "$(q1 "SELECT legacy_closed AND legacy_fence_evidence_ref='W4/$W4_ID/ai-w4-apply' AND NOT has_table_privilege('swarm_command','swarm.admin_credentials','SELECT') FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t \
  || die w4-legacy-fence 'legacy_closed with W4 evidence and no swarm_command access expected got other'
say "PASS w4-legacy-fence: legacy_closed false -> true by apply_legacy_admin_fence (evidence W4/$W4_ID/ai-w4-apply); swarm_command has no admin_credentials access; state $(state)"

# ---------------- box-written times: the EXACT box formats and the plan's own writers ----------------
if test -n "${C1_W6_PLAN_FROM:-}"; then
  say "SKIP box-time section: C1_W6_PLAN_FROM control (the released box gate is checked in tests/admin-release-plan.test.ts)"
else
# The box backup writer's real files (tests/fixtures/box-time, verbatim times) and HezLead's real W2b open.txt time; the
# test-only clock pin (tests/fixtures/box-time/sitecustomize.py) makes those exact samples "fresh" for the gate.
mkdir -p "$W6R/backups" "$T/proof-W4-gate" || exit 1
cp "$REPO/tests/fixtures/box-time/status.json" "$REPO/tests/fixtures/box-time/restore-status.json" "$W6R/backups/" || exit 1
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["window_end_utc"]="2026-10-04T22:47:31Z"; open(sys.argv[2],"w").write(json.dumps(d))' "$W4_INPUTS" "$T/proof-W4-gate/inputs.json" || exit 1
printf '2026-10-04T22:17:31Z\n' >"$T/proof-W4-gate/open.txt"
x ai-w1-backup-gate block >"$T/blocks/w4-backup-gate.sh"
x ai-backup-gate-check block >"$T/blocks/w6-ai-backup-gate-check.sh"
say "EMUL w4-backup-gate: status.json/restore-status.json are the box writer's exact samples; clock pinned to 2026-10-04T22:20:00Z (test-only sitecustomize)"
ai_run_box_gate() { test "$1" = ai-backup-gate-check || return 2; eval "$(cat "$T/blocks/w6-ai-backup-gate-check.sh")"; }
printf '%s\n' 'ai_run() { ai_run_box_gate "$@"; }' "$(cat "$T/blocks/w4-backup-gate.sh")" >"$T/blocks/w4-backup-gate-run.sh"
PYTHONPATH=$REPO/tests/fixtures/box-time C1_TEST_FIXED_NOW=2026-10-04T22:20:00Z PROOF_DIR=$T/proof-W4-gate INPUTS_FILE=$T/proof-W4-gate/inputs.json WINDOW=W4 \
  step ai-w1-backup-gate:W4-exact-box-formats "$T/blocks/w4-backup-gate-run.sh"
python3 - "$T/proof-W4-gate/backup-gate.json" <<'PY' || die w4-backup-gate 'receipt expected the box strings as written got other'
import json,sys
g=json.load(open(sys.argv[1]))
assert g['backup_verified_at']=='2026-10-04T22:12:09.199316+00:00' and g['restore_completed_at']=='2026-10-04T04:48:05.055995+00:00' and g['gate_at']=='2026-10-04T22:20:00.000000Z'
PY
say "PASS w4-backup-gate-receipt: backup_verified_at and restore_completed_at kept as the box wrote them (+00:00, microseconds); gate_at written ...Z; one receipt, both forms, accepted by the check"
# The plan's own time writers, run here, read back with the plan's own box_utc (never a hand-written value).
cat >"$T/box-utc.py" <<'PY'
import datetime,json,re,sys
src=open(sys.argv[1]).read(); defs=re.findall(r'^def box_utc\(value\):\n(?: {4}.*\n)+',src,re.M)
assert len(defs)==7 and len(set(defs))==1, 'box_utc copies'
exec(defs[0])
bad=[v for v in sys.argv[2:] if box_utc(v) is None]
if bad: raise SystemExit('FAIL box_utc refused '+json.dumps(bad))
print(' '.join(sys.argv[2:]))
PY
x ai-open line 'date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/open.txt"' >"$T/blocks/writer-open.sh"
x ai-close line 'CLOSED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)' >"$T/blocks/writer-closed.sh"
x ai-w5-closed line "(root/'closed.txt').write_text(" >"$T/blocks/writer-w5-closed.py"
mkdir -p "$T/writers" || exit 1
PROOF_DIR=$T/writers /bin/bash -c "set -euo pipefail; $(cat "$T/blocks/writer-open.sh")" || die writers 'open.txt writer failed'
WRITTEN_CLOSED=$(/bin/bash -c "set -euo pipefail; $(cat "$T/blocks/writer-closed.sh"); printf '%s' \"\$CLOSED_AT\"") || die writers 'closed.txt writer failed'
python3 -c "import datetime,pathlib; root=pathlib.Path('$T/writers'); $(cat "$T/blocks/writer-w5-closed.py")" || die writers 'W5 closed.txt writer failed'
WRITERS=$(python3 "$T/box-utc.py" "$PLANC" "$(cat "$T/writers/open.txt")" "$WRITTEN_CLOSED" "$(cat "$T/writers/closed.txt")" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gate_at"])' "$T/proof-W4-gate/backup-gate.json")" 2>&1) || die writers "$WRITERS"
say "PASS plan-time-writers: open.txt, ai-close closed.txt, ai-w5-closed closed.txt and gate_at, written by the plan's own code, all parse with box_utc: $WRITERS"
# psql-rendered times: the plan parses none (receipts only test invalidated_at for null); the real rendering for the record.
PSQL_RENDER=$(q1 "SELECT row_to_json(r) FROM (SELECT invalidated_at,measured_at FROM commonswarm_oauth.admin_cutover_state WHERE singleton) r;") || die psql-render "$(first_error "$PSQL_LOG")"
say "PASS psql-time-render: no plan parser reads a psql-rendered time; this cluster renders $PSQL_RENDER (session TimeZone $(q1 'SHOW TimeZone;'))"
fi

# ---------------- recycle hook and edge receipt ----------------
printf '%s\n' 'set -euo pipefail' "EDGE_MEASUREMENT_FILE=$W4_PROOF/edge-measurement.json" 'export EDGE_MEASUREMENT_FILE' >"$T/blocks/w6-receipt-w4.sh"
cat "$T/blocks/w6-ai-edge-receipt.sh" >>"$T/blocks/w6-receipt-w4.sh"
INPUTS_FILE=$W6_INPUTS step ai-edge-receipt:W4-measurement "$T/blocks/w6-receipt-w4.sh"
x ai-edge-refresh block >"$T/blocks/w6-ai-edge-refresh.sh"
GEN_BEFORE=$(q1 "SELECT release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")
INPUTS_FILE=$W6_INPUTS EDGE_MEASUREMENT_OUT=$W6_PROOF/edge-measurement-open.json step ai-edge-refresh:before-W6-open "$T/blocks/w6-ai-edge-refresh.sh"
timer_active || die ai-edge-refresh 'recycle timer expected re-armed got inactive'
grep -q '^systemctl stop rehearsal-edge-recycle.timer$' "$W6R/calls" || die ai-edge-refresh 'timer stop expected got none'
say "PASS recycle-hook: hook before/after on the real row (generation $GEN_BEFORE -> $(q1 "SELECT release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")); remeasure wrote a fresh receipt; timer re-armed; state $(state)"
INPUTS_FILE=$W6_INPUTS expect_fail ai-edge-receipt:stale-generation "$T/blocks/w6-receipt-w4.sh" 'generation/release_generation/measured_generation'

# Plan order: after ai-db-session, before ai-w6-prepare / activation. Issuance is CLOSED after W4.
w6_edge_grant "$W6_PROOF"

# ---------------- W6 activation checks (DB part) and G4 ----------------
x ai-w6-activation-checks from "test \"\$(ai_ro -Atq --command 'SELECT count(*) FROM commonswarm_ops.migration_checksum_failures();')\" = 0" >"$T/blocks/w6-activation-checks.sh"
x ai-w6-activation-checks lines '# The recycle hook re-verifies W4' "printf 'PASS W6 DB release identity" >"$T/blocks/w6-g4.sh"
say "EMUL ai-w6-activation-checks: readiness, approval, gates, W2b provenance, issuer live re-verification, oauth image label not run; DB, measurement, archive and G4 run"
PROOF_DIR=$W6_PROOF INPUTS_FILE=$W6_INPUTS step ai-w6-activation-checks:db-measurement-g4 "$T/blocks/w6-activation-checks.sh"
RECYCLE_ARCHIVE=$W6R/tmp/admin-issuance-$RELEASE_SHA-$W4_ID.tar
mv "$RECYCLE_ARCHIVE" "$RECYCLE_ARCHIVE.moved" || exit 1
INPUTS_FILE=$W6_INPUTS expect_fail ai-w6-activation-checks:g4-archive-missing "$T/blocks/w6-g4.sh" 'recycle archive expected retained-regular-file got missing'
mv "$RECYCLE_ARCHIVE.moved" "$RECYCLE_ARCHIVE" || exit 1

# ---------------- F2: the reviewed C1 verification row ----------------
cp "$REPO/site/public/oauth/c1-smoke/client.json" "$W6_PROOF/c1-client-document.json" || exit 1
say "EMUL ai-w6-client-document: the public document is the repository file site/public/oauth/c1-smoke/client.json (no fetch)"
OWNER=$(python3 -c 'import uuid;print(uuid.uuid4())') WS=$(python3 -c 'import uuid;print(uuid.uuid4())')
python3 - "$REPO" "$T/c1-digest.mjs" <<'PY' || exit 1
import json,pathlib,sys
url=pathlib.Path(sys.argv[1],'src/protocol/admin-policy.ts').as_uri()
open(sys.argv[2],'w').write("import { readFileSync } from 'node:fs';\nimport { createHash } from 'node:crypto';\nimport { canonicalAdminJson } from "+json.dumps(url)+";\n"
  "const doc = JSON.parse(readFileSync(process.argv[2], 'utf8'));\nprocess.stdout.write(createHash('sha256').update(canonicalAdminJson(doc)).digest('hex'));\n")
PY
C1_DIGEST=$(cd "$REPO" && "$REAL_NODE" --import tsx "$T/c1-digest.mjs" "$W6_PROOF/c1-client-document.json" 2>"$T/digest.err"); DIGEST_STATUS=$?
test "$DIGEST_STATUS" = 0 && [[ "$C1_DIGEST" =~ ^[0-9a-f]{64}$ ]] || die c1-inputs "canonicalAdminJson digest expected 64-hex got $(head -1 "$T/digest.err" | cut -c1-200)"
write_c1_inputs() { # version digest out
  python3 - "$W6_INPUTS" "$OWNER" "$WS" "$1" "$2" "$3" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); owner,ws,v,h,out=sys.argv[2:7]
c={'release_sha':d['release_sha'],'window_id':d['window_id'],'plan_sha256':d['plan_sha256'],'owner_user_id':owner,'smoke_workspace_id':ws,
   'smoke_workspace_name':'c1-smoke-rehearsal (test, archive me)','verification_version':int(v),'metadata_digest':h,
   'target_file':'/rehearsal/state/current-target.json','state_directory':'/rehearsal/state'}
open(out,'w').write(json.dumps(c)+'\n')
PY
}
write_c1_inputs 1 "$C1_DIGEST" "$W6_PROOF/C1-inputs.json" || exit 1
say "EMUL ai-w6-c1-inputs: C1-inputs.json with a fixture owner; metadata_digest from canonicalAdminJson (src/protocol/admin-policy.ts) of the document"
x ai-w6-client-verification block >"$T/blocks/w6-client-verification.sh"
# A digest that is not the document's is refused before any SQL.
cp "$W6_PROOF/C1-inputs.json" "$T/C1-inputs.good.json"
write_c1_inputs 1 "$(printf '%064d' 0)" "$W6_PROOF/C1-inputs.json" || exit 1
PROOF_DIR=$W6_PROOF INPUTS_FILE=$W6_INPUTS WINDOW=W6 expect_fail ai-w6-client-verification:digest-not-the-document "$T/blocks/w6-client-verification.sh" 'canonical document digest expected C1 metadata_digest got other'
cp "$T/C1-inputs.good.json" "$W6_PROOF/C1-inputs.json"
PROOF_DIR=$W6_PROOF INPUTS_FILE=$W6_INPUTS WINDOW=W6 step ai-w6-client-verification "$T/blocks/w6-client-verification.sh"
PROOF_DIR=$W6_PROOF INPUTS_FILE=$W6_INPUTS WINDOW=W6 step ai-w6-client-verification:identical-rerun "$T/blocks/w6-client-verification.sh"
test "$(q1 "SELECT count(*) FROM commonswarm_oauth.admin_verified_clients WHERE client_id='https://commonswarm.com/oauth/c1-smoke/client.json';")" = 1 || die c1-verification 'one C1 row expected after the rerun got other'
say "PASS c1-verification:idempotent: one row after an identical rerun"
cp "$W6_PROOF/client-verification.sql" "$T/client-verification.good.sql" || exit 1
write_c1_inputs 2 "$C1_DIGEST" "$W6_PROOF/C1-inputs.json" || exit 1
PROOF_DIR=$W6_PROOF INPUTS_FILE=$W6_INPUTS WINDOW=W6 expect_fail ai-w6-client-verification:second-active-version "$T/blocks/w6-client-verification.sh" 'another active C1 verification version'
cp "$T/C1-inputs.good.json" "$W6_PROOF/C1-inputs.json"
# The negative regenerated client-verification.sql for version 2; the proof copy is the version 1 statement again.
cp "$T/client-verification.good.sql" "$W6_PROOF/client-verification.sql" || exit 1
python3 - "$T/client-verification.good.sql" "$T/c1-http.sql" "$T/c1-differs.sql" <<'PY' || die c1-negatives 'negative SQL could not be derived'
import sys
s=open(sys.argv[1]).read()
good="ARRAY['https://commonswarm.com/oauth/c1-smoke/callback']::text[],ARRAY['admin:read'"
assert s.count(good)==1
# Trigger negative: an http redirect in a NEW version (version 7 is unused).
http=s.replace(good,good.replace('https://','http://')).replace("AND verification_version=1;","AND verification_version=7;").replace(",1,'web','cimd',",",7,'web','cimd',")
assert http.count('http://commonswarm.com/oauth/c1-smoke/callback')==1 and http.count(",7,'web','cimd',")==1
open(sys.argv[2],'w').write(http.replace("IF EXISTS(SELECT 1 FROM commonswarm_oauth.admin_verified_clients WHERE client_id='https://commonswarm.com/oauth/c1-smoke/client.json' AND active) THEN RAISE EXCEPTION 'another active C1 verification version'; END IF; ",""))
# Existing version 1 with a different reviewed field (the scope ceiling) is refused by the block's own comparison.
d=s.replace("v.scope_ceiling=ARRAY['admin:read','workspaces:create','seats:create','seats:revoke']::text[]","v.scope_ceiling=ARRAY['admin:read']::text[]")
assert d!=s; open(sys.argv[3],'w').write(d)
PY
printf 'ai_db -q --file %s >/dev/null\n' "$T/c1-http.sql" >"$T/blocks/neg-http.sh"
PROOF_DIR=$W6_PROOF expect_fail guard_verified_client:http-redirect "$T/blocks/neg-http.sh" 'admin redirect must be public HTTPS'
printf 'ai_db -q --file %s >/dev/null\n' "$T/c1-differs.sql" >"$T/blocks/neg-differs.sh"
PROOF_DIR=$W6_PROOF expect_fail ai-w6-client-verification:existing-row-differs "$T/blocks/neg-differs.sh" 'existing C1 verification differs'
printf '%s\n' "ai_db -q --command \"BEGIN; SET LOCAL ROLE commonswarm_admin_release; UPDATE commonswarm_oauth.admin_verified_clients SET scope_ceiling=ARRAY['admin:read'] WHERE client_id='https://commonswarm.com/oauth/c1-smoke/client.json'; COMMIT;\" >/dev/null" >"$T/blocks/neg-update.sh"
PROOF_DIR=$W6_PROOF expect_fail guard_verified_client:update-reviewed-field "$T/blocks/neg-update.sh" 'changed verification requires a new reviewed version'
printf '%s\n' "ai_db -q --command \"DELETE FROM commonswarm_oauth.admin_verified_clients WHERE client_id='https://commonswarm.com/oauth/c1-smoke/client.json';\" >/dev/null" >"$T/blocks/neg-delete.sh"
PROOF_DIR=$W6_PROOF expect_fail guard_verified_client:delete "$T/blocks/neg-delete.sh" 'verification history is immutable'

# ---------------- W6 activation: held timer, remeasure, activate.sql, readback ----------------
x ai-w6-activation-apply lines 'python3 - "$INPUTS_FILE" "$PROOF_DIR/activate.sql" "$PROOF_DIR/edge-measurement.json" <<' "printf 'Apply body completed; recycle timer HELD" >"$T/blocks/w6-activate.sh"
x ai-w6-activation-readback block >"$T/blocks/w6-readback.sh"
# The apply's own status/failure trap (its first statement), then its timer stop, service check and remeasure; then
# activation-attempted and activate.sql. Its approval/readiness/gate preflights are not run here.
{ x ai-w6-activation-apply lines 'C1_CLOSED_CONFIRMED=0 W6_APPLY_TIMER_HELD=0' ': "${INPUTS_FILE:?}"'
  x ai-w6-activation-apply lines 'W6_APPLY_TIMER_HELD=1' 'python3 - "$SECRET_STAGE/service.env" "$SECRET_STAGE/service.active.env" <<'
  x ai-w6-activation-apply line 'date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/activation-attempted.txt"'
  cat "$T/blocks/w6-activate.sh"
  x ai-w6-activation-apply line 'C1_BLOCK_DONE=1'; } >"$T/blocks/w6-apply-head.sh"
/bin/bash -n "$T/blocks/w6-apply-head.sh" || die w6-extract 'W6 apply slice is not valid bash'
say "EMUL ai-w6-activation-apply: approval, readiness, gates, oauth env/overlay and compose not run; failure trap, timer stop, remeasure and activate.sql run"
# Ruling 3, failure path on the real database: a failed remeasure fails the apply and its trap re-arms the timer.
printf 'bad-image' >"$W6R/docker-mode"
PROOF_DIR=$W6_PROOF INPUTS_FILE=$W6_INPUTS WINDOW=W6 expect_fail ai-w6-activation-apply:failed-measurement "$T/blocks/w6-apply-head.sh" 'edge remeasure expected PASS got failure'
printf 'good' >"$W6R/docker-mode"
timer_active || die ai-w6-activation-apply:failed-measurement 'recycle timer expected re-armed by the failure trap got inactive'
test ! -e "$W6_PROOF/edge-measurement.json" && test ! -e "$W6_PROOF/activation-attempted.txt" || die ai-w6-activation-apply:failed-measurement 'no receipt and no activation-attempted expected got present'
test "$(q1 "SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t || die ai-w6-activation-apply:failed-measurement 'issuance expected closed and invalidated got other'
test "$(marker_count)" = 1 && marker_last ai-edge-remeasure edge-measurement-failed || die w6-apply-failure 'one closed-issuance marker expected got other'
say "PASS w6-apply-failure-marker: one journal line and one 0644 log line, unit ai-edge-remeasure, reason edge-measurement-failed, measured null"
say "PASS w6-apply-failure-rearms: failed measurement left issuance closed+invalidated, no receipt, and the apply trap re-armed the timer; state $(state)"
PROOF_DIR=$W6_PROOF INPUTS_FILE=$W6_INPUTS WINDOW=W6 step ai-w6-activation-apply:remeasure-and-activate "$T/blocks/w6-apply-head.sh"
timer_active && die ai-w6-activation-apply 'recycle timer expected HELD stopped got active'
say "PASS w6-timer-held: recycle timer stopped from activation until finish; state $(state)"
PROOF_DIR=$W6_PROOF WINDOW=W6 step ai-w6-activation-readback "$T/blocks/w6-readback.sh"
printf 'ai_db -q --file /proof/client-verification.sql >/dev/null\n' >"$T/blocks/neg-open.sh"
PROOF_DIR=$W6_PROOF expect_fail ai-w6-client-verification:issuance-open "$T/blocks/neg-open.sh" 'C1 verification requires issuance closed'

# ---------------- client-check, owner approval, smoke rows, audit ----------------
python3 - "$OWNER" "$WS" "$T/smoke-owner.sql" <<'PY' || exit 1
import sys
owner,ws,out=sys.argv[1:4]
open(out,'w').write(f"""BEGIN;
INSERT INTO auth.users(id,email) VALUES('{owner}','{owner}@rehearsal.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('{owner}','C1 rehearsal owner');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('{ws}','c1-smoke-rehearsal (test, archive me)','{owner}');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('{ws}','{owner}','owner');
SET LOCAL ROLE swarm_command;
INSERT INTO swarm.admin_accounts(owner_user_id,stream_id) VALUES('{owner}',gen_random_uuid());
COMMIT;
""")
PY
run_sql_file smoke-fixture:owner-workspace "$T/smoke-owner.sql"
say "EMUL smoke-fixture: owner user, smoke workspace and owner membership (live rows the owner already has); admin account row as the first human command creates it"
x ai-w6-client-check block >"$T/blocks/w6-client-check.sh"
PROOF_DIR=$W6_PROOF WINDOW=W6 step ai-w6-client-check "$T/blocks/w6-client-check.sh"
# Owner commands and the human revoke: the command path's statements (persistEvents and the approval rows), as swarm_command.
python3 - "$OWNER" "$T" <<'PY' || exit 1
import json,sys,uuid
owner,t=sys.argv[1:3]; client='https://commonswarm.com/oauth/c1-smoke/client.json'
def event(seq,kind,payload,command,extra=None):
    e={'stream_kind':'account','owner_user_id':owner,'seq':seq,'type':kind,'actor_user':owner,'schema_version':1,'command_id':command,'payload':payload}
    e.update(extra or {}); eid=str(uuid.uuid4()); e['event_id']=eid
    return eid,"INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event) VALUES('"+owner+"',"+str(seq)+",'"+eid+"','"+command+"','"+json.dumps(e).replace("'","''")+"'::jsonb);\n"
eid,ins=event(1,'AdminClientApproved',{'client_id':client,'verification_version':1},'c1-approve')
open(t+'/owner-approve.sql','w').write("BEGIN; SET LOCAL ROLE swarm_command;\n"+ins+"INSERT INTO commonswarm_oauth.admin_client_owner_approvals(owner_user_id,client_id,verification_version,approved_at,approval_event_id,approval_command_id) VALUES('"+owner+"','"+client+"',1,statement_timestamp(),'"+eid+"','c1-approve');\nUPDATE swarm.admin_accounts SET seq=1 WHERE owner_user_id='"+owner+"';\nCOMMIT;\n")
def withdraw(seq):
    eid,ins=event(seq,'AdminClientApprovalWithdrawn',{'client_id':client,'verification_version':1,'reason_code':'smoke_cleanup'},'c1-withdraw-'+str(seq))
    return ins+"UPDATE commonswarm_oauth.admin_client_owner_approvals SET withdrawn_at=statement_timestamp(),withdrawal_event_id='"+eid+"',withdrawal_reason='smoke_cleanup' WHERE owner_user_id='"+owner+"' AND client_id='"+client+"' AND verification_version=1;\n"
def revoke(seq,grant):
    eid,ins=event(seq,'AdminDelegationRevoked',{'grant_id':grant,'reason_code':'human_revoked'},'c1-revoke-'+str(seq),{'grant_id':grant})
    return ins+"INSERT INTO swarm.admin_grants(grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,mode,registry_version,scope_names,workspace_selector,workspace_ids,created_workspace_policy,target_rules,worker_scope_ceiling,role_ceiling,renewal_limits,issuance_limits,expires_at,refresh_deadline,state,consent_receipt_id,manifest_digest,created_at,revoked_at,reason_code) SELECT grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,mode,registry_version,scope_names,workspace_selector,workspace_ids,created_workspace_policy,target_rules,worker_scope_ceiling,role_ceiling,renewal_limits,issuance_limits,expires_at,refresh_deadline,'revoked',consent_receipt_id,manifest_digest,created_at,statement_timestamp(),'human_revoked' FROM swarm.admin_grants WHERE grant_id='"+grant+"' ON CONFLICT(grant_id) DO UPDATE SET state=EXCLUDED.state,revoked_at=coalesce(swarm.admin_grants.revoked_at,EXCLUDED.revoked_at),reason_code=CASE WHEN swarm.admin_grants.state='active' THEN EXCLUDED.reason_code ELSE swarm.admin_grants.reason_code END;\n"
grant=str(uuid.uuid4()); ident=str(uuid.uuid4()); conn=str(uuid.uuid4()); family='c1-rehearsal-family-'+str(uuid.uuid4())
digest='e'*64; jkt='R'*43; jti='c1-rehearsal-access-'+str(uuid.uuid4())
import hashlib; tok=hashlib.sha256(jti.encode()).hexdigest(); run='0123456789abcdef'; issued=str(uuid.uuid4())
open(t+'/smoke-ids.json','w').write(json.dumps({'grant':grant,'family':family,'run':run}))
smoke=f"""BEGIN; SELECT set_config('c1.created',date_trunc('second',statement_timestamp())::text,true);
SET LOCAL ROLE swarm_command;
INSERT INTO swarm.admin_grants(grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,mode,registry_version,scope_names,
  workspace_selector,workspace_ids,created_workspace_policy,target_rules,worker_scope_ceiling,role_ceiling,renewal_limits,issuance_limits,
  expires_at,refresh_deadline,state,consent_receipt_id,manifest_digest,created_at)
VALUES('{grant}','{owner}','{ident}','{conn}','{client}','https://api.commonswarm.com/admin','full_account',2,ARRAY['admin:read','workspaces:create'],
  'owned_and_selected','{{}}','{{"scope_names":[]}}','{{}}','{{}}','member','{{}}','{{}}',current_setting('c1.created')::timestamptz+interval '1 day',
  current_setting('c1.created')::timestamptz+interval '1 day','active','{uuid.uuid4()}','{digest}',current_setting('c1.created')::timestamptz);
INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event) VALUES('{owner}',2,'{issued}','c1-issue',jsonb_build_object('stream_kind','account','owner_user_id','{owner}','seq',2,'type','AdminCredentialIssued','grant_id','{grant}','payload',jsonb_build_object('provider_grant_id','{family}','generation',0,'version',2)));
RESET ROLE; SET LOCAL ROLE commonswarm_oauth_runtime;
INSERT INTO commonswarm_oauth.provider_grant_resources(provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,admin_grant_id)
VALUES('{family}','https://api.commonswarm.com/admin','delegated_admin','{owner}','{client}','{conn}','{grant}');
INSERT INTO commonswarm_oauth.admin_grant_bindings(provider_grant_id,admin_grant_id,owner_user_id,admin_identity_id,connection_id,
  client_id,resource,registry_version,capabilities,scope_names,availability_digest,manifest_digest,verification_version,jkt,
  consented_at,expires_at,refresh_deadline,initial_issued_at,state)
VALUES('{family}','{grant}','{owner}','{ident}','{conn}','{client}','https://api.commonswarm.com/admin',2,
  ARRAY['list_admin_grants'],ARRAY['admin:read','workspaces:create'],'{digest}','{digest}',1,'{jkt}',current_setting('c1.created')::timestamptz,
  current_setting('c1.created')::timestamptz+interval '1 day',current_setting('c1.created')::timestamptz+interval '1 day',current_setting('c1.created')::timestamptz,'active');
INSERT INTO commonswarm_oauth.admin_oauth_audit(owner_user_id,admin_identity_id,admin_grant_id,connection_id,provider_grant_id,manifest_digest,event_kind,outcome,related_event_ids)
VALUES('{owner}','{ident}','{grant}','{conn}','{family}','{digest}','issued','committed',ARRAY['{issued}']::uuid[]);
INSERT INTO commonswarm_oauth.admin_access_issuances(access_jti,access_token_digest,provider_grant_id,admin_grant_id,generation,
  client_id,resource,jkt,manifest_digest,scope_names,issuer,kid,issued_at,expires_at,event_id,audit_id)
SELECT '{jti}',decode('{tok}','hex'),provider_grant_id,admin_grant_id,0,client_id,resource,jkt,manifest_digest,scope_names,
  'https://mcp.commonswarm.com','rehearsal-kid',date_trunc('second',statement_timestamp()),date_trunc('second',statement_timestamp())+interval '5 minutes',
  '{issued}',(SELECT audit_id FROM commonswarm_oauth.admin_oauth_audit WHERE provider_grant_id='{family}' AND event_kind='issued')
FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id='{family}';
RESET ROLE; SET LOCAL ROLE swarm_command;
"""
for kind,rid in [('init','c1_'+run+'_init'),('list','c1_'+run+'_list'),('read','c1_'+run+'_read'),('action','c1_'+run+'_create_workspace')]:
    smoke+="SELECT commonswarm_oauth.record_admin_request_audit('"+jti+"',decode('"+tok+"','hex'),'"+kind+"','"+rid+"','committed',NULL,NULL,NULL,ARRAY[]::uuid[]);\n"
smoke+="UPDATE swarm.admin_accounts SET seq=2 WHERE owner_user_id='"+owner+"';\nCOMMIT;\n"
open(t+'/smoke-grant.sql','w').write(smoke)
open(t+'/revoke.sql','w').write("BEGIN; SET LOCAL ROLE swarm_command;\n"+revoke(3,grant)+"COMMIT;\n")
open(t+'/withdraw.sql','w').write("BEGIN; SET LOCAL ROLE swarm_command;\n"+withdraw(4,)+"COMMIT;\n")
g3="SELECT state||'|'||reason_code FROM swarm.admin_grants WHERE grant_id='"+grant+"';\nSELECT count(*) FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id='"+family+"';\n"
open(t+'/g3-wrong-order.sql','w').write("BEGIN; SET LOCAL ROLE swarm_command;\n"+withdraw(3)+"RESET ROLE;\n"+g3+"ROLLBACK;\n")
open(t+'/g3-state.sql','w').write(g3)
PY
run_sql_file ai-w6-owner-client-command:approve "$T/owner-approve.sql"
say "EMUL ai-w6-owner-client-command approve: AdminClientApproved event and approval row, the command path's statements as swarm_command"
run_sql_file smoke:consent-issuance-and-request-audit "$T/smoke-grant.sql"
say "EMUL smoke: grant, provider resource, binding, issued audit and access issuance (OAuth server rows, fixture pattern) then record_admin_request_audit init/list/read/action as the command path"
SMOKE_RUN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["run"])' "$T/smoke-ids.json")
python3 - "$W6_PROOF/agent.json" "$SMOKE_RUN" <<'PY' || exit 1
import json,sys
json.dump({'run_id':sys.argv[2],'ok':True,'steps':{'read_metadata_after_refresh':{'result':'pass'},'create_workspace':{'command_id':'c1_'+sys.argv[2]+'_create_workspace'}}},open(sys.argv[1],'w'))
PY
say "EMUL ai-w6-agent-receipt: agent.json in the runner receipt shape (run_id, refreshed read, create_workspace command id)"
x ai-w6-audit block >"$T/blocks/w6-audit.sh"
PROOF_DIR=$W6_PROOF step ai-w6-audit "$T/blocks/w6-audit.sh"
say "PASS ai-w6-audit:counts: $(python3 -c 'import json,sys;print(json.dumps(json.load(open(sys.argv[1]))["audit_counts"],sort_keys=True))' "$W6_PROOF/C1-audit.json")"

# ---------------- G3: revoke and withdrawal order, both orders on the real database ----------------
G3_WRONG=$(pgx -Atq -v ON_ERROR_STOP=1 -f "$T/g3-wrong-order.sql" 2>"$PSQL_LOG") || die g3-wrong-order "$(first_error "$PSQL_LOG")"
G3_WRONG=$(printf '%s' "$G3_WRONG" | tr '\n' ' ')
case "$G3_WRONG" in 'revoked|smoke_cleanup 1') ;; *) die g3-wrong-order "withdraw-first expected the withdrawal to fence (revoked|smoke_cleanup) got $G3_WRONG" ;; esac
say "PASS g3-wrong-order (rolled back): withdrawal first fences the family itself (grant revoked|smoke_cleanup, family tombstoned); a human revoke after it finds no active grant to fence, so it would prove nothing"
say "EMUL ai-w6-human-revoke: revoke_admin_delegation as the command path's SQL (event + grant upsert as swarm_command); the CLI, HTTP, reducer and the Mac fence driver are not run"
run_sql_file ai-w6-human-revoke:command-path "$T/revoke.sql"
test "$(pgx -Atq -f "$T/g3-state.sql" 2>"$PSQL_LOG" | tr '\n' ' ')" = 'revoked|human_revoked 1 ' || die g3-right-order 'human revoke expected revoked|human_revoked with tombstone got other'
x ai-w6-fence-readback block >"$T/blocks/w6-fence-readback.sh"
PROOF_DIR=$W6_PROOF step ai-w6-fence-readback "$T/blocks/w6-fence-readback.sh"
say "EMUL ai-w6-owner-client-command withdraw: AdminClientApprovalWithdrawn event and approval update as swarm_command; the owner CLI, HTTP and reducer are not run"
run_sql_file ai-w6-owner-client-command:withdraw "$T/withdraw.sql"
test "$(pgx -Atq -f "$T/g3-state.sql" 2>"$PSQL_LOG" | tr '\n' ' ')" = 'revoked|human_revoked 1 ' || die g3-right-order 'withdrawal after the revoke expected no change got other'
test "$(q1 "SELECT withdrawn_at IS NOT NULL AND withdrawal_reason='smoke_cleanup' FROM commonswarm_oauth.admin_client_owner_approvals WHERE owner_user_id='$OWNER';")" = t || die g3-right-order 'approval withdrawn expected got other'
say "PASS g3-right-order: human revoke fenced the grant (revoked|human_revoked, family tombstoned, fence readback t); the later withdrawal is recorded and changes no grant"

# ---------------- W6 finish: default (closed) and keep_open (open) ----------------
# The WHOLE finish block, then ai-close's timer line, in one shell: ai_run is eval, so the finish block's own
# subshell must have re-armed the timer before the close looks (no extra harness boundary between them).
x ai-w6-finish block >"$T/blocks/w6-finish.sh"
# Unique in ai-close: C1-12 also added the W7 restore check, which shares the old
# `systemctl is-active --quiet "$EDGE_RECYCLE_TIMER" ||` prefix. extract requires one match.
C1_CLOSE_TIMER_ANCHOR='FAIL ai-close: recycle timer expected active got inactive; re-arm with ai-w4-timer-recovery'
C1_CLOSE_TIMER_N=$(python3 -c 'import sys; print(open(sys.argv[1],encoding="utf-8").read().count(sys.argv[2]))' "$PLANC" "$C1_CLOSE_TIMER_ANCHOR") || die w6-extract 'ai-close general timer line count failed'
test "$C1_CLOSE_TIMER_N" = 1 || die w6-extract "ai-close general timer line expected once got $C1_CLOSE_TIMER_N"
x ai-close line "$C1_CLOSE_TIMER_ANCHOR" >"$T/blocks/w6-close-timer.sh"
grep -q '^FAIL' "$T/blocks/w6-close-timer.sh" && die w6-extract "$(grep -m1 '^FAIL' "$T/blocks/w6-close-timer.sh")"
{ printf 'set -euo pipefail\n'; cat "$T/blocks/w6-finish.sh" "$T/blocks/w6-close-timer.sh"; printf 'say "PASS ai-close:timer-line after ai-w6-finish in the same shell" >&3\n'; } >"$T/blocks/w6-finish-default-run.sh"
cp "$T/blocks/w6-finish-default-run.sh" "$T/blocks/w6-finish-keep-run.sh" || exit 1
for f in "$T"/blocks/w6-finish-*-run.sh; do /bin/bash -n "$f" || die w6-extract "$(basename "$f") is not valid bash"; done
python3 - "$W6_PROOF" <<'PY' || exit 1
import json,sys
p=sys.argv[1]
json.dump({'ok':True,'refused_after_fence':{'http_status':401,'refusal_code':'invalid_token'}},open(p+'/agent-final.json','w'))
json.dump({'status':'PASS','withdrawn_at':'2026-10-04T15:30:00Z'},open(p+'/client-withdraw.json','w'))
PY
say "EMUL ai-w6-finish inputs: agent-final.json (runner refused follow-up) and client-withdraw.json receipts; the public gate probe is not run"
PROOF_DIR=$W6_PROOF INPUTS_FILE=$W6_INPUTS WINDOW=W6 step ai-w6-finish:default-closed "$T/blocks/w6-finish-default-run.sh"
timer_active || die ai-w6-finish 'recycle timer expected re-armed got inactive'
test "$(cat "$W6_PROOF/C1-finish.json")" = '{"state":"closed","explicit_keep_open":false}' || die ai-w6-finish 'C1-finish.json expected closed got other'
say "PASS w6-finish-default: closed and measured, fresh edge-measurement-final.json, timer re-armed; state $(state)"
printf '%s\n' 'set -euo pipefail' "EDGE_MEASUREMENT_FILE=$W6_PROOF/edge-measurement-final.json" 'export EDGE_MEASUREMENT_FILE' >"$T/blocks/w6-receipt-final.sh"
cat "$T/blocks/w6-ai-edge-receipt.sh" >>"$T/blocks/w6-receipt-final.sh"
INPUTS_FILE=$W7_INPUTS step ai-edge-receipt:W6-default-final "$T/blocks/w6-receipt-final.sh"

# keep_open = true (HezLead ruling 1): reactivate through the same held-timer path, then finish OPEN.
cp "$W6_PROOF/C1-fence.txt" "$W6_PROOF/client-withdraw.json" "$W6_PROOF/agent-final.json" "$W6K_PROOF/" || exit 1
PROOF_DIR=$W6K_PROOF INPUTS_FILE=$W6K_INPUTS WINDOW=W6 step ai-w6-activation-apply:keep-open-reactivate "$T/blocks/w6-apply-head.sh"
timer_active && die ai-w6-activation-apply 'recycle timer expected HELD stopped got active'
PROOF_DIR=$W6K_PROOF INPUTS_FILE=$W6K_INPUTS WINDOW=W6 step ai-w6-finish:keep-open "$T/blocks/w6-finish-keep-run.sh"
timer_active || die ai-w6-finish 'recycle timer expected re-armed got inactive'
test "$(cat "$W6K_PROOF/C1-finish.json")" = '{"state":"open","explicit_keep_open":true}' || die ai-w6-finish 'C1-finish.json expected open got other'
OPEN_MEASURED="SELECT admin_issuance_enabled AND invalidated_at IS NULL AND measured_generation=release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton;"
test "$(q1 "$OPEN_MEASURED")" = t || die ai-w6-finish 'open and measured expected got other'
say "PASS w6-finish-keep-open: reopened only through the measured hook path (lane8 digest present), timer re-armed; state $(state)"
printf '%s\n' 'set -euo pipefail' "EDGE_MEASUREMENT_FILE=$W6K_PROOF/edge-measurement-final.json" 'export EDGE_MEASUREMENT_FILE' >"$T/blocks/w6-receipt-keep.sh"
cat "$T/blocks/w6-ai-edge-receipt.sh" >>"$T/blocks/w6-receipt-keep.sh"
INPUTS_FILE=$W7_INPUTS step ai-edge-receipt:W6-keep-open-final-for-W7 "$T/blocks/w6-receipt-keep.sh"

# ---------------- W7 (right after W6, issuance live): binding to its W6 and the proof SQL ----------------
W6DIR=$W6R/home/admin-issuance/release-proofs/$RELEASE_SHA-W6-$W6_ID
mkdir -p "$W6DIR" || exit 1
python3 - "$W6K_INPUTS" "$W6DIR" "$RELEASE_SHA" "$W6_ID" <<'PY' || exit 1
import json,shutil,sys
inputs,d,sha,wid=sys.argv[1:5]; shutil.copyfile(inputs,d+'/inputs.json'); closed='2026-10-04T16:00:00Z'
open(d+'/closed.txt','w').write(closed+'\n')
open(d+'/close-result.json','w').write(json.dumps({'release_sha':sha,'window':'W6','window_id':wid,'result':'success','closed_at':closed},sort_keys=True)+'\n')
json.dump({'release_sha':sha,'status':'PASS','cleanup':True,'audit_kinds':['init','list','read','action'],'grant_revoked':True,'refresh_family_tombstoned':True,
           'live_access_refused':True,'client_approval_withdrawn':True,'final_gate':'open'},open(d+'/C1.json','w'))
PY
say "EMUL W6 close records: inputs.json, closed.txt, close-result.json and C1.json in the W6 proof directory shape ai-close and ai-w6-report write"
mkdir -p "$RELEASE_ROOT/supabase/functions/command" && cp "$REPO/supabase/functions/command/index.ts" "$RELEASE_ROOT/supabase/functions/command/index.ts" || exit 1
x ai-w7-proof from 'W7_C1_BINDING=$(ai_run ai-w7-preflight)' >"$T/blocks/w7-proof.sh"
PROOF_DIR=$W7_PROOF INPUTS_FILE=$W7_INPUTS WINDOW=W7 step ai-w7-proof:binding-and-sql "$T/blocks/w7-proof.sh"
test "$(cat "$W7_PROOF/retirement-gate-state.txt")" = t || die ai-w7-proof 'retirement gate state expected the open W6 final state t got other'
say "PASS ai-w7-proof:binding: $(python3 -c 'import json,sys;b=json.load(open(sys.argv[1]));print("w6_window_id="+b["w6_window_id"]+" final_gate="+str(b["final_gate"])+" c1_report_sha256 bound")' "$W7_PROOF/c1-report-binding.json")"
INPUTS_FILE=$W6R/inputs-W7-other.json expect_fail ai-w7-preflight:other-w6 "$T/blocks/w6-ai-w7-preflight.sh" 'W6 proof directory expected directory got missing-or-symlink'

# ---------------- ruling 1: six-hour recycles after a keep-open W6 ----------------
recycle_pair() { # label
  local before
  before=$(state); MARKERS_BEFORE=$(marker_count)
  systemctl stop "$EDGE_RECYCLE_TIMER" || exit 1
  # As the drop-in's Environment=COMMONSWARM_RECYCLE_UNIT=%n sets it for the service.
  COMMONSWARM_RECYCLE_UNIT=$EDGE_RECYCLE_SERVICE "$HOOK" before >"$T/hook.out" 2>"$T/hook.err" || die "$1" "hook before failed: $(first_error "$T/hook.err")"
  if COMMONSWARM_RECYCLE_UNIT=$EDGE_RECYCLE_SERVICE "$HOOK" after >"$T/hook.out" 2>"$T/hook.err"; then HOOK_AFTER=pass; else HOOK_AFTER=fail; fi
  MARKERS_NEW=$(( $(marker_count) - MARKERS_BEFORE ))
  systemctl start "$EDGE_RECYCLE_TIMER" || exit 1
  RECYCLE_LINE="before [$before] after [$(state)]"
}
recycle_pair recycle-good
test "$HOOK_AFTER" = pass && test "$(q1 "$OPEN_MEASURED")" = t || die recycle-good "good measurement expected reopened got $RECYCLE_LINE"
test "$MARKERS_NEW" = 0 || die recycle-good "no marker expected got $MARKERS_NEW"
say "PASS recycle-good-reopens: no marker; $RECYCLE_LINE"
printf 'bad-image' >"$W6R/docker-mode"
recycle_pair recycle-bad
printf 'good' >"$W6R/docker-mode"
test "$HOOK_AFTER" = fail && grep -q 'FAIL recycle hook; issuance CLOSED (confirmed by readback)' "$T/hook.err" || die recycle-bad "bad measurement expected hook failure got $HOOK_AFTER"
test "$(q1 "SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t || die recycle-bad "bad measurement expected closed and invalidated got $RECYCLE_LINE"
test "$MARKERS_NEW" = 1 && marker_last "$EDGE_RECYCLE_SERVICE" edge-measurement-failed || die recycle-bad "exactly one closed-issuance marker expected got $MARKERS_NEW"
say "PASS recycle-bad-stays-closed: hook after refused the wrong image; one marker (journal + 0644 log, unit $EDGE_RECYCLE_SERVICE, reason edge-measurement-failed); $RECYCLE_LINE"
recycle_pair recycle-after-bad
test "$HOOK_AFTER" = pass && test "$(q1 "SELECT NOT admin_issuance_enabled AND invalidated_at IS NULL AND measured_generation=release_generation FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t \
  || die recycle-after-bad "next good recycle expected measured-but-closed got $RECYCLE_LINE"
test "$MARKERS_NEW" = 0 || die recycle-after-bad "no new marker expected got $MARKERS_NEW"
say "PASS recycle-after-bad-stays-closed: no new marker; the next good recycle measures but keeps issuance CLOSED (intent reopen=false); keep-open is lost until a W6 reopens it; $RECYCLE_LINE"

# A marker that cannot be written is reported; the close stands (journal refused, log replaced by a symlink).
printf fail >"$W6R/logger-mode"; mv "$MARKER" "$MARKER.kept" && ln -s /dev/null "$MARKER" || exit 1
printf 'bad-image' >"$W6R/docker-mode"
recycle_pair recycle-marker-failure
printf 'good' >"$W6R/docker-mode"; printf ok >"$W6R/logger-mode"; mv -f "$MARKER.kept" "$MARKER" || exit 1
test "$HOOK_AFTER" = fail && grep -q 'FAIL recycle closed-marker not fully written' "$T/hook.err" && grep -q 'FAIL recycle hook; issuance CLOSED (confirmed by readback)' "$T/hook.err" \
  || die recycle-marker-failure 'marker failure expected reported with the hook failure got other'
test "$(q1 "SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t || die recycle-marker-failure 'closed and invalidated expected got other'
say "PASS recycle-marker-failure-close-stands: journal and log refused; the failure is reported and the readback-confirmed CLOSED state stands; $RECYCLE_LINE"

if test -z "${C1_W6_PLAN_FROM:-}"; then
MARKER_TIMES=$(python3 -c 'import json,sys; print(" ".join(json.loads(l)["at"] for l in open(sys.argv[1]).read().splitlines()))' "$MARKER") || die marker-times 'marker lines expected JSON got other'
MARKER_OK=$(python3 "$T/box-utc.py" "$PLANC" $MARKER_TIMES 2>&1) || die marker-times "$MARKER_OK"
say "PASS marker-times: every closed-issuance marker 'at' written by the hook parses with box_utc ($(printf '%s\n' $MARKER_TIMES | wc -l | tr -d ' ') lines)"
fi

# ---------------- a shared remeasure that fails AFTER a committed reopen closes issuance (from OPEN) ----------------
W6Q_PROOF=$T/proof-W6-postfail; mkdir -p "$W6Q_PROOF" || exit 1
PROOF_DIR=$W6Q_PROOF INPUTS_FILE=$W6K_INPUTS WINDOW=W6 step ai-w6-activation-apply:reopen-before-postfail "$T/blocks/w6-apply-head.sh"
test "$(q1 "$OPEN_MEASURED")" = t || die remeasure-postfail 'open and measured expected got other'
printf '%s\n' 'set -euo pipefail' "EDGE_MEASUREMENT_OUT=$W6Q_PROOF/edge-measurement-postfail.json" 'ai_run ai-edge-remeasure' >"$T/blocks/remeasure-postfail.sh"
MARKERS_BEFORE=$(marker_count) BEFORE_POSTFAIL=$(state)
printf 'query-fails' >"$W6R/docker-mode"
PROOF_DIR=$W6Q_PROOF INPUTS_FILE=$W6K_INPUTS expect_fail ai-edge-remeasure:row-read-fails-after-reopen "$T/blocks/remeasure-postfail.sh" 'cutover row expected readable got failure'
printf 'good' >"$W6R/docker-mode"
test "$NEG_STATUS" = 1 || die remeasure-postfail "remeasure status 1 (confirmed CLOSED) expected got $NEG_STATUS"
test "$(q1 "SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t || die remeasure-postfail "closed and invalidated expected got $(state)"
test "$(( $(marker_count) - MARKERS_BEFORE ))" = 1 && marker_last ai-edge-remeasure remeasure-validation-failed || die remeasure-postfail 'one remeasure-validation-failed marker expected got other'
say "PASS remeasure-postfail-closes: the hook pair reopened, the row read then failed, and the hook close mode closed and invalidated issuance with one marker (reason remeasure-validation-failed); before [$BEFORE_POSTFAIL] after [$(state)]"

# ---------------- a reopen that COMMITS but whose response is lost (scheduled recycle path) ----------------
marker_event_last() { python3 -c 'import json,sys; print(json.loads(open(sys.argv[1]).read().splitlines()[-1])["event"])' "$MARKER"; }
W6L_PROOF=$T/proof-W6-lost; mkdir -p "$W6L_PROOF" || exit 1
PROOF_DIR=$W6L_PROOF INPUTS_FILE=$W6K_INPUTS WINDOW=W6 step ai-w6-activation-apply:reopen-before-lost-response "$T/blocks/w6-apply-head.sh"
printf 'lose-reopen-response' >"$W6R/docker-mode"
recycle_pair recycle-lost-reopen-response
printf 'good' >"$W6R/docker-mode"
test "$HOOK_AFTER" = fail && grep -q 'reopen not confirmed; issuance closed again (confirmed by readback)' "$T/hook.err" || die recycle-lost-reopen-response "confirmed re-close expected got $HOOK_AFTER"
test "$(q1 "SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t || die recycle-lost-reopen-response "closed expected got $RECYCLE_LINE"
test "$MARKERS_NEW" = 1 && test "$(marker_event_last)" = admin-issuance-closed-needs-reactivation || die recycle-lost-reopen-response "one CLOSED marker expected got $MARKERS_NEW"
say "PASS recycle-lost-reopen-response: the reopen committed, its response was lost; the hook closed again and confirmed CLOSED by readback before one CLOSED marker; $RECYCLE_LINE"

# ---------------- refused failure close: every caller reports UNKNOWN, never CLOSED (finish in the same shell) ----------------
W6U_PROOF=$T/proof-W6-unknown; mkdir -p "$W6U_PROOF" || exit 1
cp "$W6_PROOF/C1-fence.txt" "$W6_PROOF/client-withdraw.json" "$W6_PROOF/agent-final.json" "$W6U_PROOF/" || exit 1
PROOF_DIR=$W6U_PROOF INPUTS_FILE=$W6K_INPUTS WINDOW=W6 step ai-w6-activation-apply:reopen-before-unknown "$T/blocks/w6-apply-head.sh"
MARKERS_BEFORE=$(marker_count)
printf 'lose-reopen-and-close' >"$W6R/docker-mode"
PROOF_DIR=$W6U_PROOF INPUTS_FILE=$W6K_INPUTS WINDOW=W6 expect_fail ai-w6-finish:keep-open-close-refused "$T/blocks/w6-finish-keep-run.sh" 'FAIL ai-w6-finish: issuance state UNKNOWN after the remeasure failure \(may be OPEN\)'
printf 'good' >"$W6R/docker-mode"
test "$NEG_STATUS" = 2 || die ai-w6-finish:keep-open-close-refused "finish status 2 (UNKNOWN) expected got $NEG_STATUS"
grep -q 'issuance CLOSED' "$T/neg.err" && die ai-w6-finish:keep-open-close-refused 'no CLOSED claim expected got one'
grep -q "issuance stays closed" "$T/neg.err" && die ai-w6-finish:keep-open-close-refused 'no closed claim expected got one'
timer_active || die ai-w6-finish:keep-open-close-refused 'recycle timer expected re-armed got inactive'
test "$(q1 "SELECT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t || die ai-w6-finish:keep-open-close-refused 'the modelled refused close leaves issuance OPEN; expected t got other'
test "$(( $(marker_count) - MARKERS_BEFORE ))" = 2 && test "$(marker_event_last)" = admin-issuance-state-unknown && ! tail -2 "$MARKER" | grep -q closed-needs-reactivation \
  || die ai-w6-finish:keep-open-close-refused 'two state-unknown markers and no CLOSED marker expected got other'
say "PASS w6-finish-unknown-propagates: reopen committed, both closes refused; issuance really OPEN; the hook, the remeasure and the finish all report UNKNOWN (may be OPEN), two state-unknown markers, no CLOSED claim; finish exit status 2; timer re-armed"
printf '%s\n' 'set -euo pipefail' 'ai_run ai-w6-activation-rollback' >"$T/blocks/recover-unknown.sh"
PROOF_DIR=$W6U_PROOF step ai-emergency-close:recover-unknown "$T/blocks/recover-unknown.sh"
test "$(q1 "SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t || die ai-emergency-close:recover-unknown 'closed expected got other'
# Recovered-close / rollback order: emergency-close then ai-w6-edge-oauth-runtime-revoke.
if test -f "$W6_PROOF/edge-oauth-runtime-grant.txt"; then
  cp "$W6_PROOF/edge-oauth-runtime-grant-attempted.txt" "$W6_PROOF/edge-oauth-runtime-grant.txt" "$W6U_PROOF/" || die ai-w6-edge-oauth-runtime-revoke 'this-window grant evidence expected copyable got missing'
fi
w6_edge_revoke "$W6U_PROOF"

# ---------------- ruling 3: emergency close of an OPEN W6 re-arms the held timer ----------------
# Issuance returns only through a W6 activation (new proof directory), which holds the timer; then the emergency path.
W6E_PROOF=$T/proof-W6-emergency; mkdir -p "$W6E_PROOF" || exit 1
w6_edge_grant "$W6E_PROOF"
PROOF_DIR=$W6E_PROOF INPUTS_FILE=$W6K_INPUTS WINDOW=W6 step ai-w6-activation-apply:reopen-before-emergency "$T/blocks/w6-apply-head.sh"
timer_active && die ai-w6-activation-apply 'recycle timer expected HELD stopped got active'
test "$(q1 "$OPEN_MEASURED")" = t || die ai-w6-activation-apply 'open and measured expected got other'
printf '%s\n' 'set -euo pipefail' 'ai_run ai-w6-activation-rollback' >"$T/blocks/emergency.sh"
PROOF_DIR=$W6E_PROOF step ai-emergency-close:activation-rollback "$T/blocks/emergency.sh"
timer_active || die ai-emergency-close 'recycle timer expected re-armed got inactive'
test "$(q1 "SELECT NOT admin_issuance_enabled AND invalidated_at IS NOT NULL FROM commonswarm_oauth.admin_cutover_state WHERE singleton;")" = t || die ai-emergency-close 'closed and invalidated expected got other'
w6_edge_revoke "$W6E_PROOF"
say "PASS emergency-close-rearms: open issuance with the timer held; the emergency path's activation rollback closed and invalidated it in one transaction and re-armed the timer; state $(state)"
say "PASS rehearsal: W4, recycle hook, W6 activation/C1/G3/finish (both keep_open paths), W7, recycles and emergency close on the post-W2 database"

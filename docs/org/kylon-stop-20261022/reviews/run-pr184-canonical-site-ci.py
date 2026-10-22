"""Prepared UNRUN: PR184 relevant canonical siteCI after one actual source/image cross-family PASS."""
from pathlib import Path
import subprocess as sp,json,hashlib,datetime
ROOT=Path('/Users/yulanbot/work/kylon-redesign');APP=ROOT/'app'
HEAD='3a45f7f67ff8fb50a17de4a2ce2d7cafd20e20fb';BASE='81b5fb71f20030cf71b7927964a2c08c425a1ab3'
SSH='/Users/yulanbot/work/pe-ci-hetzner/s';OUT=ROOT/'evidence/ci/lists-inline-pr184-3a45f7f-run01'
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def git(*args):return sp.check_output(['git','-C',str(APP),*args])
def save(n,v):(OUT/n).write_text(json.dumps(v,indent=2)+'\n')
source=ROOT/'reviews/LISTS-INLINE-ITEM-PREPARED.json';i=json.loads(source.read_text())
assert i['head']==HEAD and i['base']==BASE and git('rev-parse',HEAD+'^{tree}').decode().strip()==i['tree']
assert git('merge-base',BASE,HEAD).decode().strip()==BASE
assert set(git('diff','--name-only',BASE,HEAD).decode().splitlines())==set(i['paths']) and len(i['paths'])==3
for path,fact in i['candidateFiles'].items():
 b=git('show',HEAD+':'+path);assert len(b)==fact['bytes'] and hashlib.sha256(b).hexdigest()==fact['sha256']
review=ROOT/'reviews/LISTS-PR184-REVIEW-ROOT-ADOPTION.json';a=json.loads(review.read_text())
assert a['head']==HEAD and a['tree']==i['tree'] and a['base']==BASE and a['verdict']=='PASS' and a['blockingCards']==0
assert a['family']=='anthropic' and a['makerFamily']=='openai' and a['rootFullReportRead'] and a['allFourActualImagesRead'] and a['completeChangedPatchRead']
assert sha(Path(a['review']))==a['reviewSha256'] and sha(Path(a['task']))==a['taskSha256']
proof=ROOT/'reviews/LISTS-PR184-CI01-RUNNER-LOCK.json';slot=json.loads(proof.read_text());shared=Path('/Users/yulanbot/work/PE-CI-1.lock');st=shared.stat()
assert slot['head']==HEAD and slot['state'].startswith('HELD') and slot['job']=='PR184 canonical siteCI01'
assert not shared.is_symlink() and st.st_dev==slot['device'] and st.st_ino==slot['inode'] and (shared/'holder').read_text()==slot['holder']
assert not OUT.exists();OUT.mkdir(mode=0o700)
save('INPUT-GATES.json',{'head':HEAD,'source':sha(source),'review':sha(review),'scope':'Three-path inline item controls, existing SSR regression, one cross-family source/imagePASS0; no new backend or tools. One canonical site CI; no extra export/staging/dark proof.'})
preflight='set -eu\ntest "$(hostname -s)" = pe-ci-1\nci_owned_listing=$(sudo -n docker ps -q)\ntest -z "$ci_owned_listing"\nci_probe=0\npgrep -x Runner.Worker >/dev/null || ci_probe=$?\ntest "$ci_probe" = 1\nprintf "pe-ci-1 fresh 0/0 passed\\n"\n'
with (OUT/'preflight.txt').open('xb') as f:sp.run([SSH,preflight],stdout=f,stderr=sp.STDOUT,check=True,timeout=45)
command='sudo -n runuser -u commonswarm-ci -g commonswarm-ci -G docker -- bash /opt/commonswarm-ci/scripts/run.sh --sha '+HEAD+' --suite site'
record={'head':HEAD,'suite':'site','command':command,'startedUtc':now(),'state':'RUNNING'};save('dispatch.json',record)
with (OUT/'controller.log').open('xb') as log:result=sp.run([SSH,command],stdout=log,stderr=sp.STDOUT)
record.update(finishedUtc=now(),controllerExit=result.returncode,state='TERMINAL; root reads actual gates/artifacts/owned cleanup then releases own lock before runner-free');save('terminal.json',record);print(json.dumps(record));raise SystemExit(result.returncode)

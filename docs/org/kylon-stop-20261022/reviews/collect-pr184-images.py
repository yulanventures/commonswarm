"""Post-run artifact readback only; no application or browser execution."""
from pathlib import Path
import json,hashlib,tarfile,datetime
ROOT=Path('/Users/yulanbot/work/kylon-redesign');OUT=ROOT/'candidate/lists-inline-review-images-job-v1/generated/lists-review-images-01'
HEAD='3a45f7f67ff8fb50a17de4a2ce2d7cafd20e20fb';TREE='601c359061d8d3f9de9882e6391c9dbde965346c'
def sha(b):return hashlib.sha256(b).hexdigest()
def read(p):return json.loads(p.read_text())
def write(p,v):p.write_text(json.dumps(v,indent=2)+'\n')
state=read(OUT/'state.json');receipt=read(OUT/'receipt.json');retrieval=read(OUT/'retrieval.json');cleanup=read(OUT/'root-cleanup.json')
assert state['heads']=={'lists':HEAD} and state['exitCode']==0 and state['error'] is None and state['retrieved'] and state['ownedRootRemoved']
assert receipt['exitCode']==0 and receipt['error'] is None and receipt['cleanup']['ownedContainers']==0 and cleanup['ownedContainers']==0
archive=(OUT/'results.tar').read_bytes();assert len(archive)==retrieval['bytes'] and sha(archive)==retrieval['sha256']==cleanup['resultsSha256']
with tarfile.open(OUT/'results.tar','r:') as tf:
 m=tf.extractfile('result-files.json');assert m;facts=json.loads(m.read());assert len(facts)>100
 for name,fact in facts.items():
  p=OUT/'retrieved'/name;assert p.resolve().is_relative_to(OUT/'retrieved') and not p.is_symlink()
  b=p.read_bytes();assert {'bytes':len(b),'sha256':sha(b)}==fact
before=read(OUT/'source-metadata-bindings-before.json');assert before==read(OUT/'source-metadata-bindings-after.json')
binding=read(OUT/'binding.json');after=read(OUT/'local-bindings-after.json');assert binding['run']==after['run'] and binding['sshWrapper']==after['sshWrapper'] and binding['inputs']==after['inputs']
index=read(OUT/'retrieved/work/records/image-index.json');assert index['heads']=={'lists':HEAD} and index['captureFinished'] and not index['errors'] and len(index['images'])==len(index['contexts'])==4
assert all(c['complete'] and not c['errors'] for c in index['contexts'])
keep=['tag','id','class','x','y','right','bottom','width','height','scrollWidth','scrollHeight','clientWidth','clientHeight','scrollTop','scrollLeft','hidden','rendered','inViewport','size','weight','lineHeight','display','overflowX','overflowY','color','background','ariaBusy']
def box(v):return None if v is None else {k:v[k] for k in keep if k in v}
images=[];imageFacts={}
for i in index['images']:
 assert i['head']==HEAD and i['tree']==TREE and i['theme']=='light' and i['state']=='normal'
 p=OUT/'retrieved/work/proofs/lists'/Path(i['file']).name;b=p.read_bytes();fact={'bytes':len(b),'sha256':sha(b)};assert fact=={k:i[k] for k in fact};imageFacts[str(p)]=fact
 r=i['raw'];assert len(r['visibleH1'])==1 and r['fontsStatus']=='loaded'
 geometry={k:box(r.get(k)) for k in ['heading','rail','context','workspaceHeader','phoneHeader','objects','selected','refresh','description']}
 geometry['visibleH1']=[box(v) for v in r['visibleH1']]
 controls=[{**box(v),**{k:v[k] for k in ['action','disabled','ariaLabel','ariaCurrent','ariaExpanded'] if k in v},'text':v.get('text','')[:180]} for v in r['controls'] if v.get('action') or (v.get('rendered') and v.get('inViewport'))]
 if i['mode']=='list':
  toggles=[v for v in controls if v.get('action')=='toggle'];assert len(toggles)==5 and all(v['width']>=44 and v['height']>=44 and v.get('ariaLabel','').strip() for v in toggles)
 images.append({**{k:i[k] for k in ['head','tree','width','height','mode','theme','state','scope']},'file':str(p),**fact,'geometry':geometry,'nativeControls':controls,'documentWidth':r['documentWidth'],'fontsStatus':r['fontsStatus'],'contentKind':r['contentKind'],'fixture':{k:r['fixture'][k] for k in ['hostMounted','calls','selectedId','saveState','agents','connections']}})
summary={'head':HEAD,'scope':index['scope'],'errors':index['errors'],'captureFinished':True,'images':images,'limits':'Four normal light initial sample views, actual native source; no interaction/keyboard/live/backend/dark/full-scroll proof. Full raw DOM retained in image-index; bounded summary intentionally excludes whole-document text/styles.'}
assert len(json.dumps(summary))<160000
write(OUT/'CRITIC-IMAGE-SUMMARY.json',summary)
adoption={'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':HEAD,'tree':TREE,'state':'ACTUAL capture terminalPASS; returned hashes/source bindings/exact owned root cleanup verified; image opening pending','verifiedReturnedFileCount':len(facts),'resultArchive':retrieval,'images':imageFacts,'imageSummary':str(OUT/'CRITIC-IMAGE-SUMMARY.json'),'captureErrors':0,'rootAllFourActualImagesOpened':False,'limits':summary['limits']}
write(ROOT/'reviews/LISTS-PR184-IMAGE-ROOT-ADOPTION.json',adoption)
print(json.dumps({'returnedFiles':len(facts),'images':imageFacts,'captureErrors':0,'summaryBytes':(OUT/'CRITIC-IMAGE-SUMMARY.json').stat().st_size}))

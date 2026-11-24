"""Archive protocol fixture: actual receipt/prepare must ship the pinned helper."""
from pathlib import Path
import base64
import hashlib
import io
import json
import os
import subprocess
import tarfile
import tempfile

BASE=Path(__file__).resolve().parents[4]
TOOLS=BASE/'deploy/site'
h=lambda data:hashlib.sha256(data).hexdigest()
revision='1234567890abcdef1234567890abcdef12345678'
image='node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d'
# Synthetic public anon-role JWT: no credentials used by this fixture.
key='e30.'+base64.urlsafe_b64encode(b'{"role":"anon"}').decode().rstrip('=')+'.fixture'
pub=dict(PUBLIC_SUPABASE_URL='https://api.commonswarm.com',PUBLIC_SUPABASE_ANON_KEY=key,PUBLIC_H0_LINK_JOIN='0')
html=f'<meta name="commonswarm:url" content="{pub["PUBLIC_SUPABASE_URL"]}"><meta name="commonswarm:anon-key" content="{key}"><p>fixture</p>'.encode()
csp="default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://api.commonswarm.com wss://api.commonswarm.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
next_html=(f'<!doctype html><html lang="en"><head><meta charset="UTF-8" />'
           f'<meta http-equiv="Content-Security-Policy" content="{csp}" />'
           f'<meta name="commonswarm:url" content="{pub["PUBLIC_SUPABASE_URL"]}" />'
           f'<meta name="commonswarm:anon-key" content="{key}" />'
           f'<script type="module" src="/next/assets/index-fixture.js"></script></head><body></body></html>').encode()
def archive(path,entries,pax=None):
    with tarfile.open(path,'w',format=tarfile.PAX_FORMAT if pax else tarfile.USTAR_FORMAT,pax_headers=pax) as tar:
        for name,data in entries.items():
            info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644
            tar.addfile(info,io.BytesIO(data))
with tempfile.TemporaryDirectory(prefix='site-repair-prepare-') as tmp:
    root=Path(tmp)
    source={ 'deploy/site/'+name:(TOOLS/name).read_bytes() for name in ['finalize-release.sh','validate-site-env.mjs','refresh-site.py'] }
    source.update({'deploy/site/build-artifact.sh':b'fixture builder','site/package-lock.json':b'{}','app/package-lock.json':b'{"app":true}'})
    def run(*args,ok=True,env_extra=None):
        env=dict(os.environ)
        env.pop('COMMONSWARM_INCLUDE_NEXT',None)
        if env_extra: env.update(env_extra)
        r=subprocess.run(['node',str(TOOLS/'validate-site-env.mjs'),*args],capture_output=True,text=True,env=env)
        assert (r.returncode==0)==ok,r.stderr
        return r
    def stage_dir(sub,site_entries):
        d=root/sub; d.mkdir()
        archive(d/'source.tar',source,{'comment':revision})
        archive(d/'site.tar',site_entries)
        (d/'public.json').write_text(json.dumps(pub))
        (d/'finalize-release.sh').write_bytes((TOOLS/'finalize-release.sh').read_bytes())
        return d
    base_entries={name:html for name in ['index.html','app/index.html','start/index.html']}
    next_entries={**base_entries,'next/index.html':next_html,'next/assets/index-fixture.js':b'console.log(1);'}
    # Default (COMMONSWARM_INCLUDE_NEXT unset): preview is OFF; receipt matches pre-PR schema cleanly.
    off_default=stage_dir('off-default',base_entries)
    run('receipt',str(off_default),revision,image)
    off_receipt_bytes=(off_default/'BUILD.json').read_bytes()
    off_receipt=json.loads(off_receipt_bytes)
    assert off_receipt['refresh']==h((TOOLS/'refresh-site.py').read_bytes())
    assert sorted(off_receipt.keys())==['artifact','builder','config','h0','html','image','lock','refresh','revision','source','template','validator']
    assert 'next/index.html' not in off_receipt['html']
    run('prepare',str(off_default),h(off_receipt_bytes),'/root/cswarm-site-fixture')
    packet=off_default/'packet'
    assert (packet/'refresh-site.py').read_bytes()==(TOOLS/'refresh-site.py').read_bytes()
    for line in (packet/'PACKET.sha256').read_text().splitlines():
        pin,name=line.split();assert h((packet/name).read_bytes())==pin
    assert 'refresh-site.py' in (packet/'PACKET.sha256').read_text()
    rendered_off=(packet/'SITE-DIRECT.sh').read_text()
    assert '@@' not in rendered_off and "if [[ '0' == 1 ]]" in rendered_off
    # Explicit COMMONSWARM_INCLUDE_NEXT=0 produces a receipt byte-identical to unset.
    off_zero=stage_dir('off-zero',base_entries)
    run('receipt',str(off_zero),revision,image,env_extra={'COMMONSWARM_INCLUDE_NEXT':'0'})
    assert (off_zero/'BUILD.json').read_bytes()==off_receipt_bytes
    # Stray next/ member is refused when unset or 0; invalid values fail closed.
    stray=stage_dir('stray-next',next_entries)
    run('receipt',str(stray),revision,image,ok=False)
    run('receipt',str(stray),revision,image,ok=False,env_extra={'COMMONSWARM_INCLUDE_NEXT':'0'})
    for bad in ['','2','yes','true']:
        run('receipt',str(stray),revision,image,ok=False,env_extra={'COMMONSWARM_INCLUDE_NEXT':bad})
    # Explicit opt-in: COMMONSWARM_INCLUDE_NEXT=1 pins next/index.html, appLock, and nextAssets.
    on_next=stage_dir('on-next',next_entries)
    run('receipt',str(on_next),revision,image,env_extra={'COMMONSWARM_INCLUDE_NEXT':'1'})
    on_receipt=json.loads((on_next/'BUILD.json').read_text())
    assert on_receipt['appLock']==h(b'{"app":true}')
    assert on_receipt['next']=='1' and on_receipt['nextAssets']==['/next/assets/index-fixture.js']
    assert 'next/index.html' in on_receipt['html']
    run('prepare',str(on_next),h((on_next/'BUILD.json').read_bytes()),'/root/cswarm-site-next')
    rendered_on=(on_next/'packet/SITE-DIRECT.sh').read_text()
    assert '@@' not in rendered_on and "if [[ '1' == 1 ]]" in rendered_on
    # Change archived helper without changing BUILD: provenance must reject before packet creation.
    source['deploy/site/refresh-site.py']+=b'\n# changed\n'
    archive(off_default/'source.tar',source,{'comment':revision})
    run('prepare',str(off_default),h((off_default/'BUILD.json').read_bytes()),'/root/cswarm-site-fixture2',ok=False)
print(json.dumps({'passed':True,'checks':['actual receipt and prepare package helper from bound source archive','manifest includes helper and all hashes match','default unset and COMMONSWARM_INCLUDE_NEXT=0 omit next/ and produce byte-identical pre-PR receipts','invalid COMMONSWARM_INCLUDE_NEXT values fail closed','COMMONSWARM_INCLUDE_NEXT=1 opt-in pins app/package-lock.json, next/index.html, and nextAssets','changed source helper rejected by build provenance']},indent=2))

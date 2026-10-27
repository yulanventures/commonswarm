"""Archive protocol fixture: actual receipt/prepare must ship the pinned helper."""
from pathlib import Path
import base64
import hashlib
import io
import json
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
def archive(path,entries,pax=None):
    with tarfile.open(path,'w',format=tarfile.PAX_FORMAT if pax else tarfile.USTAR_FORMAT,pax_headers=pax) as tar:
        for name,data in entries.items():
            info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644
            tar.addfile(info,io.BytesIO(data))
with tempfile.TemporaryDirectory(prefix='site-repair-prepare-') as tmp:
    root=Path(tmp)
    source={ 'deploy/site/'+name:(TOOLS/name).read_bytes() for name in ['finalize-release.sh','validate-site-env.mjs','refresh-site.py'] }
    source.update({'deploy/site/build-artifact.sh':b'fixture builder','site/package-lock.json':b'{}'})
    archive(root/'source.tar',source,{'comment':revision})
    archive(root/'site.tar',{name:html for name in ['index.html','app/index.html','start/index.html']})
    (root/'public.json').write_text(json.dumps(pub))
    (root/'finalize-release.sh').write_bytes((TOOLS/'finalize-release.sh').read_bytes())
    def run(*args,ok=True):
        r=subprocess.run(['node',str(TOOLS/'validate-site-env.mjs'),*args],capture_output=True,text=True)
        assert (r.returncode==0)==ok,r.stderr
    run('receipt',str(root),revision,image)
    receipt=json.loads((root/'BUILD.json').read_text())
    assert receipt['refresh']==h((TOOLS/'refresh-site.py').read_bytes())
    run('prepare',str(root),h((root/'BUILD.json').read_bytes()),'/root/cswarm-site-fixture')
    packet=root/'packet'
    assert (packet/'refresh-site.py').read_bytes()==(TOOLS/'refresh-site.py').read_bytes()
    for line in (packet/'PACKET.sha256').read_text().splitlines():
        pin,name=line.split();assert h((packet/name).read_bytes())==pin
    assert 'refresh-site.py' in (packet/'PACKET.sha256').read_text()
    assert '@@' not in (packet/'SITE-DIRECT.sh').read_text()
    # Change archived helper without changing BUILD: provenance must reject before packet creation.
    source['deploy/site/refresh-site.py']+=b'\n# changed\n'
    archive(root/'source.tar',source,{'comment':revision})
    run('prepare',str(root),h((root/'BUILD.json').read_bytes()),'/root/cswarm-site-fixture2',ok=False)
print(json.dumps({'passed':True,'checks':['actual receipt and prepare package helper from bound source archive','manifest includes helper and all hashes match','standard H0 placeholder rendered','changed source helper rejected by build provenance']},indent=2))

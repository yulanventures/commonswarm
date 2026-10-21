"""Run actual rendered release/rollback lifecycle; only host/paths/tools are adapted for macOS."""
from pathlib import Path
import functools
import hashlib
import http.server
import io
import json
import os
import shutil
import socket
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request

BASE=Path(__file__).resolve().parents[4]
hashbytes=lambda data:hashlib.sha256(data).hexdigest()
checks=[]
class Handler(http.server.SimpleHTTPRequestHandler):
    fail_app=False
    def log_message(self,*args): pass
    def do_GET(self):
        if self.fail_app and self.path=='/app' and (Path(self.directory).resolve().name=='candidate'):
            self.send_error(503); return
        if self.path == '/app': self.path = '/app/'
        super().do_GET()

def get(url,date=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers={'If-Modified-Since':date} if date else {})) as r:
            return r.status,r.headers.get('Last-Modified')
    except urllib.error.HTTPError as e: return e.code,e.headers.get('Last-Modified')

def scenario(baseline=False, automatic=False, failure=None, rollback_failure=None):
    with tempfile.TemporaryDirectory(prefix='site-shell-http-') as tmp:
        root=Path(tmp).resolve(); site=root/'site'; old=site/'releases/old'; reserve=root/'reserve'; reserve.mkdir()
        (old/'_astro').mkdir(parents=True); (old/'app').mkdir()
        for path in ['index.html','app/index.html']:
            (old/path).write_text('old HTML')
            os.utime(old/path,(int(time.time())-20,int(time.time())-20))
        (old/'_astro/old.js').write_text('old module')
        (site/'current').symlink_to(old)
        now=int(time.time())
        contents={'index.html':b'new HTML','app/index.html':b'new app HTML','_astro/new.js':b'import "./chunks/dynamic.js"','_astro/chunks/dynamic.js':b'new dynamic','_astro/new.css':b'new css'}
        if failure=='collision': contents['_astro/old.js']=b'collision'
        with tarfile.open(reserve/'site.tar','w',format=tarfile.USTAR_FORMAT) as tar:
            for name,data in contents.items():
                info=tarfile.TarInfo(name); info.size=len(data); info.mtime=now; info.mode=0o644
                tar.addfile(info,io.BytesIO(data))
        (reserve/'BUILD.json').write_text('{}')
        shutil.copyfile(BASE/'deploy/site/refresh-site.py',reserve/'refresh-site.py')
        if failure=='symlink': (old/'_astro/link').symlink_to(old/'_astro/old.js')
        if failure=='future': os.utime(old/'index.html',(now+60,now+60))
        Handler.fail_app=automatic
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(site/'current')))
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        url=f'http://127.0.0.1:{server.server_port}'
        source=BASE/'deploy/site/finalize-release.sh'
        values=dict(RESERVE=str(reserve),RELEASE='candidate',BUILD_SHA=hashbytes((reserve/'BUILD.json').read_bytes()),ARTIFACT_SHA=hashbytes((reserve/'site.tar').read_bytes()),ROOT_SHA=hashbytes(contents['index.html']),APP_SHA=hashbytes(contents['app/index.html']),REVISION='fixture',H0='1',REFRESH_SHA=hashbytes((reserve/'refresh-site.py').read_bytes()))
        text=subprocess.check_output(['git','show','2df93aca44f6157ebd3dcfaf1e6b94116ae69887:deploy/site/finalize-release.sh'],cwd=BASE,text=True) if baseline else source.read_text()
        for k,v in values.items(): text=text.replace('@@'+k+'@@',v)
        text=text.replace('S=/srv/commonswarm/site;',f'S={site};').replace('test "$EUID" = 0',f'test "$EUID" = {os.geteuid()}').replace('= yulan-vps-1','= '+socket.gethostname().split('.')[0]).replace('/etc/commonswarm-release/STAGING-ONLY',str(root/'STAGING-ONLY')).replace('https://commonswarm.com',url)
        # macOS mv lacks GNU -T; preserve atomic rename through os.replace.
        bindir=root/'bin'; bindir.mkdir()
        mv=bindir/'mv'; mv.write_text('#!/usr/bin/env python3\nimport os,sys\nos.replace(sys.argv[-2],sys.argv[-1])\n'); mv.chmod(0o755)
        script=reserve/'SITE-DIRECT.sh'; script.write_text(text)
        env=dict(os.environ,PATH=str(bindir)+':'+os.environ['PATH'])
        def run(mode): return subprocess.run(['bash',str(script),mode],env=env,capture_output=True,text=True)
        try:
            prior=get(url+'/app/')[1]
            r=run('deploy')
            if failure:
                assert r.returncode!=0 and (site/'current').resolve()==old,(failure,r.returncode)
                checks.append(f'full shell {failure}: fails before flip, old live retained'); return
            if automatic:
                assert r.returncode!=0 and (site/'current').resolve()==old
                assert 'PASS rollback' in (reserve/'hostrun.log').read_text()
                assert get(url+'/app/',prior)[0]==200
                assert get(url+'/_astro/new.js')[0]==200
                checks.append('full shell automatic rollback on postflip HTTP 503: rollback PASS, conditional 200, new asset 200'); return
            assert r.returncode==0,(reserve/'hostrun.log').read_text()
            deployed=get(url+'/app/')[1]
            if not baseline:
                assert get(url+'/app/',prior)[0]==200
                for name in ['old.js','new.js','chunks/dynamic.js','new.css']: assert get(url+'/_astro/'+name)[0]==200
            if rollback_failure:
                if rollback_failure=='collision': (old/'_astro/new.js').write_text('different bytes')
                if rollback_failure=='symlink': (old/'_astro/bad').symlink_to(old/'_astro/old.js')
                if rollback_failure=='future': os.utime(old/'index.html',(time.time()+60,time.time()+60))
                r=run('rollback')
                assert r.returncode!=0 and (site/'current').resolve()==site/'releases/candidate'
                assert get(url+'/_astro/new.js')[0]==200
                checks.append(f'full shell rollback {rollback_failure}: refused before flip, new live retained')
                return
            r=run('rollback'); assert r.returncode==0,(reserve/'hostrun.log').read_text()
            if not baseline:
                assert (old/'_astro/chunks').stat().st_mode & 0o777 == 0o755
            expected=(304,404) if baseline else (200,200)
            actual=(get(url+'/app/',deployed)[0],get(url+'/_astro/new.js')[0]); assert actual==expected,actual
            if baseline: checks.append('full OLD script: rollback reproduces HTTP 304 + missing new module 404')
            else:
                r=run('rollback'); assert r.returncode==0
                assert 'PASS rollback unchanged' in (reserve/'hostrun.log').read_text()
                for name in ['old.js','new.js','chunks/dynamic.js','new.css']: assert get(url+'/_astro/'+name)[0]==200
                checks.append('full NEW deploy/explicit rollback/repeated rollback: conditional 200, both graphs 200, unchanged PASS')
        finally:
            server.shutdown(); server.server_close(); thread.join()
scenario(baseline=True)
scenario()
scenario(automatic=True)
for failure in ['collision','symlink','future']: scenario(failure=failure)
for failure in ['collision','symlink','future']: scenario(rollback_failure=failure)
print(json.dumps({'passed':True,'checks':checks,'ceiling':'macOS HTTP fixture with real rendered templates/helper; only paths/host/root guard/HTTP origin and GNU mv adaptation changed; no Caddy/Cloudflare or production execution'},indent=2))

"""Exercise actual refresh helper + real HTTP whole-second conditional requests."""
from pathlib import Path
import contextlib
import functools
import http.server
import json
import os
import subprocess
import tempfile
import threading
import time
import urllib.request
import urllib.error

BASE = Path(__file__).resolve().parents[4]
HELPER = BASE / 'deploy/site/refresh-site.py'
results = []
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

def get(url, modified=None):
    request = urllib.request.Request(url, headers={'If-Modified-Since': modified} if modified else {})
    try:
        with urllib.request.urlopen(request) as r: return r.status, r.headers.get('Last-Modified'), r.read()
    except urllib.error.HTTPError as e: return e.code, e.headers.get('Last-Modified'), e.read()

def refresh(live, target, ok=True):
    r = subprocess.run(['python3', str(HELPER), str(live), str(target)], capture_output=True, text=True)
    assert (r.returncode == 0) == ok, r.stderr
    return r

def flip(root, target):
    (root / 'next').symlink_to(target)
    os.replace(root / 'next', root / 'current')

with tempfile.TemporaryDirectory(prefix='site-cache-http-') as tmp:
    root = Path(tmp).resolve()
    old, new = root/'old', root/'new'
    for release, tag in [(old,'old'), (new,'new')]:
        (release/'_astro/chunks').mkdir(parents=True)
        (release/'app').mkdir()
        for name in ['index.html', 'app/index.html']:
            (release/name).write_text(f'<script type="module" src="/_astro/{tag}.js"></script>')
        for name, content in [(f'{tag}.js',f'import "./chunks/{tag}.js"'),(f'chunks/{tag}.js',tag),(f'{tag}.css',tag)]:
            (release/'_astro'/name).write_text(content)
        for p in release.rglob('*.html'): os.utime(p, (int(time.time())-10, int(time.time())-10))
    (root/'current').symlink_to(old)
    server = http.server.ThreadingHTTPServer(('127.0.0.1',0), functools.partial(Handler, directory=str(root/'current')))
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    url = f'http://127.0.0.1:{server.server_port}'
    try:
        # Exact baseline behavior: forward-copy only; older rollback HTML.
        import shutil
        shutil.copytree(old/'_astro',new/'_astro',dirs_exist_ok=True)
        for p in new.rglob('*.html'): os.utime(p,(int(time.time())-5,int(time.time())-5))
        flip(root,new); _, browser_date, _ = get(url+'/app/')
        flip(root,old)
        assert get(url+'/app/',browser_date)[0] == 304
        assert get(url+'/_astro/new.js')[0] == 404
        results.append('OLD reproduced: rollback conditional 304 + new entry 404')
        # Match both HTML clocks to this very second: subsecond touching is insufficient.
        now = int(time.time())
        for release in [old,new]:
            for p in release.rglob('*.html'): os.utime(p,(now,now))
        date = get(url+'/app/')[1]
        refresh(old,new); flip(root,new)
        assert get(url+'/app/',date)[0] == 200
        previous = get(url+'/app/')[1]
        refresh(new,old); flip(root,old)
        assert get(url+'/app/',previous)[0] == 200
        results.append('NEW same-second activation and immediate rollback: conditional 200')
        for tag in ['old','new']:
            for name in [f'{tag}.js', f'chunks/{tag}.js', f'{tag}.css']:
                assert get(url+'/_astro/'+name)[0] == 200
        results.append('NEW rollback: both entry/dynamic-import/CSS graphs 200 (6 assets)')
        # Same target, same helper: safe to repeat, preserving bytes and availability.
        refresh(old,old)
        assert get(url+'/app/')[0] == 200
        results.append('NEW repeated rollback idempotent content/assets')
        for p in new.rglob('*.html'): assert p.stat().st_mtime <= time.time()
        for kind in ['collision','symlink','future','parent-collision']:
            bad=root/kind; shutil.copytree(new,bad)
            if kind=='collision': (bad/'_astro/old.js').write_text('wrong bytes')
            if kind=='symlink': (bad/'_astro/link.js').symlink_to(new/'_astro/new.js')
            if kind=='future': os.utime(bad/'index.html',(time.time()+60,time.time()+60))
            if kind=='parent-collision':
                shutil.rmtree(bad/'_astro/chunks'); (bad/'_astro/chunks').write_text('wrong type')
            before=os.readlink(root/'current')
            refresh(old,bad,ok=False)
            assert os.readlink(root/'current') == before
        results.append('NEW collisions/symlink/future/parent collision refuse before flip; live preserved')
        # Freeze only wall-clock reads; real monotonic time must terminate the wait.
        stamp=int(time.time())
        for release in [old,new]:
            for p in release.rglob('*.html'): os.utime(p,(stamp,stamp))
        code='import runpy,sys; from unittest.mock import patch; sys.argv='+repr([str(HELPER),str(old),str(new)])+'; '+"\nwith patch('time.time',return_value="+str(stamp)+"):\n runpy.run_path("+repr(str(HELPER))+",run_name='__main__')"
        r=subprocess.run(['python3','-c',code],capture_output=True,text=True,timeout=5)
        assert r.returncode!=0 and 'clock did not advance within 2 seconds' in r.stderr
        assert (root/'current').resolve()==old
        results.append('NEW frozen wall clock hits real monotonic 2-second guard; live retained')
    finally:
        server.shutdown(); server.server_close(); thread.join()
print(json.dumps({'passed':True, 'checks':results, 'ceiling':'local Python HTTP origin; no production Caddy/Cloudflare or full shell lifecycle exercised'},indent=2))

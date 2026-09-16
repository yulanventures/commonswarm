"""N-edge step-3 production controls through the new path (api.commonswarm.com -> Cloudflare -> yulan-vps-1).

Forces api.commonswarm.com to a Cloudflare anycast address of the zone through a Node --require preload, so a stale
local resolver cannot send the checks to the old Supabase CNAME. Prints only statuses and timings, never secrets.
"""
import json, os, subprocess, sys, time, hashlib, tempfile, urllib.request

SP = sys.argv[1]
CF_IP = sys.argv[2] if len(sys.argv) > 2 else "104.21.79.89"
MP = os.path.expanduser("~/.cswarm/connect-4989ea3b-af59-4c74-a9a6-eeaf51154b5d/profile.json")
prof = json.load(open(MP))
cred = os.path.join(os.path.dirname(MP), prof["credential_file"])
WS = "4f63d2b0-8d95-4ea3-b46a-ac573cebc432"
URL = "https://api.commonswarm.com"
W = os.path.join(SP, "window")
M = os.path.join(SP, "measure")

pre = os.path.join(W, "api-override.cjs")
open(pre, "w").write(
    'const dns=require("node:dns");const o=dns.lookup;'
    f'const MAP={{"api.commonswarm.com":"{CF_IP}"}};'
    'dns.lookup=function(h,opts,cb){if(typeof opts==="function"){cb=opts;opts={};}const ip=MAP[h];'
    'if(ip){if(opts&&opts.all)return process.nextTick(cb,null,[{address:ip,family:4}]);return process.nextTick(cb,null,ip,4);}'
    'return o.call(dns,h,opts,cb);};'
)

def env():
    e = {k: v for k, v in os.environ.items() if k not in ("NODE_OPTIONS", "FORCE_COLOR")}
    e["SWARM_CLOUD_URL"] = URL
    e["SWARM_CLOUD_ANON_KEY"] = prof["anon_key"]
    e["NODE_OPTIONS"] = f"--require {pre}"
    return e

results = []
def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)

def cli(args, timeout=90):
    t = time.time()
    p = subprocess.run(["cswarm", *args, "--agent-token-file", cred, "--workspace-id", WS, "--json"],
                       env=env(), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    return p.returncode, time.time() - t, p.stdout, p.stderr[-200:]

# 0. the path really is Cloudflare -> box: curl with --resolve, look for cf-ray and the edge container's answer
h = subprocess.run(["curl", "-s", "-o", "/dev/null", "-D", "-", "--resolve", f"api.commonswarm.com:443:{CF_IP}",
                    f"{URL}/functions/v1/h0/agent-doc/AAAAAAAAAAAAAAAAAAAAAA"], capture_output=True, text=True)
hdr = h.stdout.lower()
record("h0 document via api host is 200 through cloudflare", " 200" in hdr.splitlines()[0] if hdr else False,
       "cf-ray present" if "cf-ray" in hdr else "no cf-ray")

# 1. CLI reads and a command
for name, args in (("cli members", ["members"]), ("cli feed", ["feed", "--limit", "5"]),
                   ("cli receipt (command edge)", ["receipt", "000c8ce0-bed7-44bc-a35d-0b5100617025"])):
    rc, dt, out, err = cli(args)
    record(name, rc == 0, f"exit={rc} {dt:.2f}s" + ("" if rc == 0 else f" err={err}"))

# 2. file upload, read back, remove
tmp = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, dir=W)
body = f"N-edge cutover control {time.time()}\n"; tmp.write(body); tmp.close()
name = f"n-edge-cutover-control-{int(time.time())}.txt"
rc, dt, out, err = cli(["file", "put", tmp.name, "--name", name], timeout=120)
record("file put", rc == 0, f"exit={rc} {dt:.2f}s" + ("" if rc == 0 else f" err={err}"))
if rc == 0:
    outp = os.path.join(W, "readback.txt")
    rc2, dt2, _, err2 = cli(["file", "get", name, "--out", outp, "--force"], timeout=120)
    same = rc2 == 0 and os.path.exists(outp) and open(outp).read() == body
    record("file get round trip identical", same, f"exit={rc2} {dt2:.2f}s" + ("" if rc2 == 0 else f" err={err2}"))
    rc3, dt3, _, err3 = cli(["file", "rm", name])
    record("file rm", rc3 == 0, f"exit={rc3}" + ("" if rc3 == 0 else f" err={err3}"))
    try: os.remove(outp)
    except OSError: pass
os.remove(tmp.name)

# 3. realtime subscribe + broadcast through the api host
p = subprocess.run(["node", os.path.join(M, "rt-probe.mjs"), URL], env={**env()}, capture_output=True, text=True, timeout=60, cwd=M)
out = p.stdout
record("realtime subscribe", "SUBSCRIBED" in out, " | ".join(l for l in out.splitlines() if "subscribe" in l))
record("realtime broadcast round trip", "broadcast round trip:" in out and "NO BROADCAST" not in out,
       " | ".join(l for l in out.splitlines() if "broadcast" in l))

# 4. auth and rest through the api host with the public anon key (header file, 0600, removed after)
hdrfile = os.path.join(W, "anon.hdr")
fd = os.open(hdrfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, f"apikey: {prof['anon_key']}\n".encode()); os.close(fd)
for route, want in (("/auth/v1/health", "200"), ("/auth/v1/settings", "200"), ("/storage/v1/status", "200"), ("/rest/v1/", "401")):
    c = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--resolve", f"api.commonswarm.com:443:{CF_IP}",
                        "-H", f"@{hdrfile}", f"{URL}{route}"], capture_output=True, text=True).stdout
    record(f"{route} is {want}", c == want, f"got {c}")
os.remove(hdrfile)

# 5. the app shell (still on Vercel) loads and names the api host
c = subprocess.run(["curl", "-s", "https://commonswarm.com/start"], capture_output=True, text=True).stdout
record("site /start publishes api.commonswarm.com", 'commonswarm:url" content="https://api.commonswarm.com"' in c)

bad = [r for r in results if not r[1]]
print(f"\nSTEP-3 CONTROLS: {len(results) - len(bad)}/{len(results)} passed")
sys.exit(1 if bad else 0)

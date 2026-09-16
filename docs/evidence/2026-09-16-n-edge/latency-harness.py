import json,os,subprocess,time,statistics,sys
M=sys.argv[1]
MP=os.path.expanduser("~/.cswarm/connect-4989ea3b-af59-4c74-a9a6-eeaf51154b5d/profile.json")
prof=json.load(open(MP)); cred=os.path.join(os.path.dirname(MP), prof["credential_file"])
ws="4f63d2b0-8d95-4ea3-b46a-ac573cebc432"; sig="000c8ce0-bed7-44bc-a35d-0b5100617025"
paths={"production":"https://api.commonswarm.com","staging-box":"https://edge-staging.commonswarm.com"}
def run(url, args):
    env={k:v for k,v in os.environ.items() if k not in ("NODE_OPTIONS","FORCE_COLOR")}
    env["SWARM_CLOUD_URL"]=url; env["SWARM_CLOUD_ANON_KEY"]=prof["anon_key"]
    env["NODE_OPTIONS"]=f"--require {M}/dns-override.cjs"
    t=time.time(); p=subprocess.run(["cswarm",*args,"--agent-token-file",cred,"--workspace-id",ws,"--json"],env=env,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=120)
    return time.time()-t, p.returncode, (p.stderr or "")[-160:]
ops={"read members":["members"],"read feed":["feed","--limit","5"],"command receipt":["receipt",sig]}
res={}
for i in range(15):
    for opname,args in ops.items():
        for pname,url in paths.items():
            dt,rc,err=run(url,args); res.setdefault((opname,pname),[]).append((dt,rc,err))
for (opname,pname),xs in res.items():
    ok=[d for d,rc,_ in xs if rc==0]; bad=[(rc,e) for d,rc,e in xs if rc!=0]
    q=sorted(ok)
    p50=statistics.median(q) if q else None; p95=q[max(0,int(round(0.95*len(q)))-1)] if q else None
    print(f"{opname:16} {pname:12} n_ok={len(ok):2} p50={p50:.3f}s p95={p95:.3f}s" if q else f"{opname:16} {pname:12} n_ok=0", "| failures:", len(bad), (bad[0] if bad else ""))

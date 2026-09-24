#!/bin/bash
# Item I production control. Usage: control.sh <cswarm artifact copied outside the repo> <out dir>
# Binds a COPY of the lead seat's profile to a fake session A (the renewal lead is 15 min before a 2026-10-10 expiry,
# so the copy does not renew). Prints codes and exit statuses only; never a token.
set -u
BIN="$1"; OUT="$2"; SRC="$HOME/.cswarm/connect-4989ea3b-af59-4c74-a9a6-eeaf51154b5d"
umask 077; D=$(mktemp -d "$OUT/profile.XXXX"); chmod 700 "$D"
cp "$SRC/credential.json" "$D/credential.json"
A="prodctl-A-$(date -u +%Y%m%d%H%M%S)"; B="prodctl-B-other"
python3 - "$SRC/profile.json" "$D" "$A" <<'PY'
import json,sys,os
src,d,a=sys.argv[1:4]; p=json.load(open(src)); p['credential_file']=os.path.join(d,'credential.json'); p['host_session_id']=a
fd=os.open(os.path.join(d,'profile.json'),os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); os.write(fd,json.dumps(p).encode()); os.close(fd)
PY
NONET='(version 1)(allow default)(deny network-outbound (remote ip))'
code(){ python3 -c 'import json,sys
t=sys.stdin.read()
try:
  d=json.loads(t); e=d.get("error") or {}; print(e.get("code") or ("ok checked=%s messages=%s"%(d.get("checked"),len(d.get("messages",[])))))
except Exception: print("nonjson:", t.strip().splitlines()[-1][:160] if t.strip() else "(empty)")'; }
echo "session A, network on:";   "$BIN" check --profile "$D/profile.json" --host-session-id "$A" --json 2>&1 | code; echo "  exit ${PIPESTATUS[0]}"
echo "session B, network off:";  sandbox-exec -p "$NONET" "$BIN" check --profile "$D/profile.json" --host-session-id "$B" --json 2>&1 | code; echo "  exit ${PIPESTATUS[0]}"
echo "no id, network off:";      sandbox-exec -p "$NONET" "$BIN" check --profile "$D/profile.json" --json 2>&1 | code; echo "  exit ${PIPESTATUS[0]}"
echo "control: session A, network off (must fail on the network):"; sandbox-exec -p "$NONET" "$BIN" check --profile "$D/profile.json" --host-session-id "$A" --json 2>&1 | code; echo "  exit ${PIPESTATUS[0]}"
echo "session B note, network off:"; sandbox-exec -p "$NONET" "$BIN" note "item I control" --profile "$D/profile.json" --host-session-id "$B" --json 2>&1 | code; echo "  exit ${PIPESTATUS[0]}"
rm -rf "$D"; echo "copy removed: $([ -e "$D" ] && echo no || echo yes)"

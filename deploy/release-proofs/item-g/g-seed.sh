#!/bin/bash
# Item G section 6, steps 1-3, run by the lead ON THE MINI after Anvil reports the new edge healthy.
# Usage: g-seed.sh <cswarm-bin> <dir> <url> <workspace-id>
#   <cswarm-bin>  the cswarm release candidate built from the box-release SHA, copied OUTSIDE the repository
#   <dir>         a 0700 directory holding sender.json and recipient.json (the minted credential JSON lines, 0600)
#                 and anon-key.txt (0600; the public anon key, never typed: fetched from the site meta tag)
#   <url>         https://api.commonswarm.com in production; a loopback URL in the local rehearsal
# Prints only ids, statuses and exit codes; never a token. Exit codes: 0 pass; 2 bad input files or a credential with
# less than 90 minutes left (mint again; the edge is not implicated); 4 STOP (the edge did not accept the unclaimed
# observed ACK); 5 STOP (the read-edge probe failed or could not connect); 6 an unexpected CLI failure (read the JSON
# files in <dir> before deciding anything about the edge).
set -euo pipefail
BIN="$1"; DIR="$2"; URL="$3"; WS="$4"
mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }
[ "$(mode "$DIR")" = 700 ] || { echo "input: $DIR must be mode 0700"; exit 2; }
for f in sender.json recipient.json anon-key.txt; do
  [ -f "$DIR/$f" ] && [ "$(mode "$DIR/$f")" = 600 ] || { echo "input: $DIR/$f must exist with mode 0600"; exit 2; }
done
umask 077
# A token with less than 90 minutes left could expire, or be renewed by the recipient's check (which retires the old
# token), in the middle of the run; either would fake a STOP. Refuse to start instead.
python3 - "$DIR/sender.json" "$DIR/recipient.json" <<'PY' || exit 2
import datetime, json, sys
now = datetime.datetime.now(datetime.timezone.utc)
for path in sys.argv[1:]:
    raw = json.load(open(path)).get("expires_at")
    if not raw:
        print(f"input: {path} has no expires_at; mint again"); sys.exit(1)
    left = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00")) - now
    if left < datetime.timedelta(minutes=90):
        print(f"input: {path} expires in {int(left.total_seconds() // 60)} min (< 90); mint again"); sys.exit(1)
PY
ANON="$(cat "$DIR/anon-key.txt")"
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }
RECIPIENT="$(field "$DIR/recipient.json" principal_id)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SESSION="g-seed-$TS"
PROFILE_DIR="$DIR/recipient-profile"
PROFILE="$PROFILE_DIR/profile.json"
python3 - "$DIR" "$URL" "$ANON" "$WS" "$RECIPIENT" "$PROFILE_DIR" "$PROFILE" <<'PY'
import json, os, sys
d, url, anon, ws, principal, profile_dir, profile_path = sys.argv[1:8]
# readAgentProfile requires credential_file == join(dirname(profile_path), "credential.json"),
# so the recipient credential must be copied alongside the profile under that exact name — it
# cannot point at $DIR/recipient.json directly (that made every check fail with profile_invalid).
os.makedirs(profile_dir, exist_ok=True)
os.chmod(profile_dir, 0o700)
credential_file = os.path.join(profile_dir, "credential.json")
with open(os.path.join(d, "recipient.json"), "rb") as src:
    credential_bytes = src.read()
fd = os.open(credential_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, credential_bytes); os.close(fd)
profile = {"version": 1, "url": url, "anon_key": anon, "workspace_id": ws, "principal_id": principal,
           "credential_file": credential_file}
fd = os.open(profile_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, json.dumps(profile).encode()); os.close(fd)
PY
sender() { "$BIN" "$@" --agent-token-file "$DIR/sender.json" --url "$URL" --anon-key "$ANON" --workspace-id "$WS" --json; }
signal_id() { python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("signal") or d)["id"])'; }

# 0. The recipient's first check sets its cursor, so the notes below are new to it.
"$BIN" check --profile "$PROFILE" --host-session-id "$SESSION" --json >"$DIR/check0.json" \
  || { echo "step 0: recipient check failed (exit $?)"; exit 6; }
echo "step 0: recipient baseline check exit 0"

# 1. Note 1; the recipient's check shows it and sends one unclaimed observed ACK.
N1="$(sender note "G seed note 1 $TS" --to "$RECIPIENT" | signal_id)" || { echo "step 1: note 1 failed"; exit 6; }
echo "step 1: note 1 = $N1"
"$BIN" check --profile "$PROFILE" --host-session-id "$SESSION" --json >"$DIR/check1.json" \
  || { echo "step 1: recipient check failed (exit $?)"; exit 6; }
python3 - "$DIR/check1.json" "$N1" <<'PY' || { echo "step 1: the recipient check did not show note 1"; exit 6; }
import json, sys
d = json.load(open(sys.argv[1])); ids = [m.get("id") for m in d.get("messages", [])]
sys.exit(0 if sys.argv[2] in ids else 1)
PY
# STOP GATE: the sender's receipt must say the recipient observed note 1. The CLI swallows a refused ACK, so only the
# server's receipt proves the new edge accepted the unclaimed shape (an old edge refuses the unclaimed key).
sender receipt "$N1" >"$DIR/receipt1.json" || { echo "step 1: receipt read failed"; exit 6; }
python3 - "$DIR/receipt1.json" "$RECIPIENT" <<'PY' || { echo "STOP step 1: the edge did not record the unclaimed observed ACK"; exit 4; }
import json, sys
d = json.load(open(sys.argv[1]))
rows = [r for r in d.get("receipts", []) if r.get("recipient_agent_principal_id") == sys.argv[2]]
# `receipt --json` names this field "outcome" (and mirrors it in "state"), not "ack_outcome" —
# that name belongs to the swarm.signal_deliveries column, not the CLI's receipt shape.
sys.exit(0 if rows and rows[0].get("outcome") == "observed" and rows[0].get("acked_at") else 1)
PY
echo "step 1: PASS the receipt says observed"

# 2. Note 2; the recipient does NOT check it.
N2="$(sender note "G seed note 2 $TS" --to "$RECIPIENT" | signal_id)" || { echo "step 2: note 2 failed"; exit 6; }
echo "step 2: note 2 = $N2 (left unchecked)"

# 3. Read-edge probe with the recipient's credential (the profile's copy, which the CLI keeps current): the body the
# CLI sends; 200 and it contains note 2. This is a health check of the read path; it does not tell the new read edge
# from the old one (step 1 does that).
trap 'rm -f "$DIR/read-headers.txt"' EXIT
python3 - "$DIR" "$ANON" "$PROFILE_DIR" <<'PY'
import json, os, sys
d, anon, profile_dir = sys.argv[1:4]
tok = json.load(open(os.path.join(profile_dir, "credential.json")))["agent_token"]
fd = os.open(os.path.join(d, "read-headers.txt"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, f"Authorization: Bearer {tok}\napikey: {anon}\nContent-Type: application/json\n".encode()); os.close(fd)
PY
printf '{"resource":"signals","workspace_id":"%s","inbox":true,"about":null,"kind":null,"since":null,"in_reply_to":null,"after_created_at":null,"after_id":null,"limit":50,"include_stale":false}' "$WS" >"$DIR/read-body.json"
CODE="$(curl -sS --max-time 30 -o "$DIR/read-resp.json" -w '%{http_code}' -X POST -H @"$DIR/read-headers.txt" \
  --data @"$DIR/read-body.json" "$URL/functions/v1/read")" || CODE="000"
rm -f "$DIR/read-headers.txt"
python3 - "$DIR/read-resp.json" "$N2" "$CODE" <<'PY' || { echo "STOP step 3: read-edge probe failed (HTTP $CODE)"; exit 5; }
import json, sys
body, n2, code = sys.argv[1:4]
if code != "200":
    sys.exit(1)
ids = [s.get("id") for s in json.load(open(body)).get("signals", [])]
sys.exit(0 if code == "200" and n2 in ids else 1)
PY
echo "step 3: PASS read edge 200 and it contains note 2"
echo "SEED_NOTE_ID=$N2"

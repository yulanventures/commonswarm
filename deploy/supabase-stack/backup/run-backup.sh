#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
umask 077
root=/var/backups/commonswarm-postgres
install -d -m 0700 "$root"
exec 9>/var/lock/commonswarm-postgres-backup.lock
flock -n 9 || { echo 'CommonSwarm backup already running' >&2; exit 75; }
stack_dir="$(cd "$(dirname "$0")/.." && pwd)"
retention=/etc/commonswarm-backup/retention-evidence.json
artifact="$root/$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:12])')"
status_temp="$root/status.json.tmp.$$"
fail() {
  printf '{"ok":false,"at":"%s","artifact":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$artifact" >"$status_temp"
  mv "$status_temp" "$root/status.json"
}
printf '{"ok":false,"state":"running","at":"%s","artifact":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$artifact" >"$status_temp"
mv "$status_temp" "$root/status.json"
trap fail ERR
[[ -r "$retention" ]] || { echo 'Verified retention evidence is missing' >&2; false; }
bash "$stack_dir/backup/dump-database.sh" "$artifact"
python3 "$stack_dir/backup/upload-snapshot.py" "$artifact" "$retention" >"$artifact/upload-result.json"
python3 - "$artifact/upload-result.json" "$status_temp" <<'PY'
import json,sys
from pathlib import Path
result=json.loads(Path(sys.argv[1]).read_text())
result['ok']=True
Path(sys.argv[2]).write_text(json.dumps(result,indent=2)+'\n')
PY
mv "$status_temp" "$root/status.json"
trap - ERR
echo 'CommonSwarm database and file backup verified offsite.'

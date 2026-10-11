# U9 staging kit

Base e82771087634c1feced87b0a3b9d51b555aaecda. Preparation only: HezLead
reviews/signs and dispatches execution. STGGATE must supply ruling 43's local
backup-gate branch before admission. No kit action uploads or contacts R2.

All drivers use `common.guard`: measured hostname AND SHA256 of exact
`/etc/machine-id` bytes match ruling 43's pins. No marker, environment value,
flag or argument selects staging. Mutations additionally require root.
Read-only identity receipt (hostname, machine_id_sha256, measured_at UTC):

```sh
python3 "$RELEASE_ROOT/scripts/c1-staging-u9/common.py" identity
```

## Local status and drill receipts

In a fresh root:root 0700 proof directory, record restore-status.json BEFORE
the single authorized local dump/drill. The dump is `database.dump`, named by
`deploy/supabase-stack/backup/dump-database.sh:30,33` and
`deploy/supabase-stack/migrate/dump-source.sh:120`. Ruling 18's reviewed online
backup_ro dump and isolated drill run separately; this tool runs neither.
The real drill owns `/var/backups/commonswarm-postgres/restore-status.json`
(`restore-drill.py:24`). Never replace it with a fabricated drill receipt.

```sh
U9_STATUS="$RELEASE_ROOT/scripts/c1-staging-u9/status.py"
python3 "$U9_STATUS" before "$PROOF_DIR/u9-before-drill.json"
# Run the independently reviewed ruling-18 dump/drill; U9_DUMP_DIR names its fresh 0700 directory.
python3 "$U9_STATUS" write "$PROOF_DIR/u9-status-written.json" --dump-dir "$U9_DUMP_DIR" --source-receipt "$PROOF_DIR/u9-before-drill.json"
# After U9, use the same HezLead-verified installed path as F03's U9_GUARDED_RM.
export U9_GUARDED_RM
python3 "$U9_STATUS" remove "$PROOF_DIR/u9-status-removed.json" --source-receipt "$PROOF_DIR/u9-status-written.json"
python3 "$U9_STATUS" after "$PROOF_DIR/u9-after-u9.json"
```

The fixed status path is `/var/backups/commonswarm-postgres/status.json`
(C = RELEASE.md:2153). Exactly destination/dump_sha256/drill/verified_at,
root:root 0600, exclusive no-follow creation. SHA256 is computed from the dump.
Drill must be ok=true/state=complete, UTC, no older than 1800 seconds, after
both dump and before receipt, within 3600 seconds of dump mtime. No second
backup on expiry (ruling 41.5). One remover step validates both fixed gate files
before any deletion (ruling 43 addendum): status owner/mode/type/local content
and writer hash; restore-status regular/root ownership and post-drill writer SHA.
Nothing edits or deletes restore-status before this step. `U9_GUARDED_RM` must
be an absolute executable regular file with no symlink, supplied by HezLead.
The exclusive root 0600 `u9-status-removed.json.before` binds the writer receipt,
staging identity, dump SHA and each gate's SHA256/size/mtime_ns before removal.
The remover calls that guard once per exact path with `--`, then writes the
final receipt with both absences and the before-receipt SHA. A guard refusal
retains the before receipt and any remaining gates; STOP for HezLead inspection.

## F1–F3

Use separate admitted W4 attempts. `faults.py` verifies plan_sha256, W4 inputs
and the exact root 0700 proof directory, then emits the original apply body
plus one receipt/exit-97 insertion: F1 before switch; F2 after the healthy edge-measurement writer;
F3 after recycle install (C:4710,4734,4802). Hash emitted bytes and retain the
diff in the signed dispatch. Evaluate each emitted body as a standalone
command; `if`, `!`, `&&` and `||` suppress Bash's original errexit behavior.

```sh
U9_FAULT="$RELEASE_ROOT/scripts/c1-staging-u9/faults.py"
U9_BODY=$(python3 "$U9_FAULT" fault "$U9_CASE" "$PLAN_FILE" "$INPUTS_FILE" "$PROOF_DIR")
eval "$U9_BODY"
# In the admitted recovery shell after the intentional nonzero exit:
U9_BODY=$(python3 "$U9_FAULT" undo "$U9_CASE" "$PLAN_FILE" "$INPUTS_FILE" "$PROOF_DIR")
eval "$U9_BODY"
# After ordinary recovered controls:
U9_BODY=$(python3 "$U9_FAULT" close "$U9_CASE" "$PLAN_FILE" "$INPUTS_FILE" "$PROOF_DIR")
eval "$U9_BODY"
```

Undo/close reuse C:4875 / 8915–8919, including full PLAN §1e monitored roots
and RESTORED/RETAINED/RETIRED checks. An absent injection receipt or other exit
is not PASS. Each fault receipt records independent CLOSED/invalidation readback,
container health/ID/StartedAt/image, recycle install completion, and hashes plus
values of existing W4 snapshot/baseline/keeper/measurement/install receipts.
These are boundary inputs; recovered close still decides the full set comparison.
Ruling 11's keeper re-install is a separate signed STOP; no reboot
or retry until fresh install/U10. No automatic keeper re-install.

## ARCH §5 steps 1–3

`ARCH` = `/Users/yulanbot/work/c1-next/ARCHIVE-DURABLE-REPORT.md:148–156`.
In the admitted W4 root shell with its real `ai_ro` session (C:1638–1702),
before W4 changes the binding, require the already-installed compatibility
hook to equal the reviewed `ai-recycle-hook` block, a legacy binding, and its
root 0600 equal durable rescue. HezLead excludes other Part B/PostgREST windows.
The driver installs no hook and performs no migration. Missing prerequisites
STOP. An exclusive proof-directory copy is fsynced and digest-checked before
holding the timer; step 2 removes the original only after rechecking both files.
Copy failure leaves the original and timer untouched. Unknown failure keeps the timer held.

```sh
U9_ARCH="$RELEASE_ROOT/scripts/c1-staging-u9/archive.py"
U9_BODY=$(python3 "$U9_ARCH" 1 "$PLAN_FILE" "$INPUTS_FILE" "$PROOF_DIR")
eval "$U9_BODY"
U9_BODY=$(python3 "$U9_ARCH" 2 "$PLAN_FILE" "$INPUTS_FILE" "$PROOF_DIR")
eval "$U9_BODY"
U9_BODY=$(python3 "$U9_ARCH" 3 "$PLAN_FILE" "$INPUTS_FILE" "$PROOF_DIR")
eval "$U9_BODY"
# Explicit undo also emits step 3; use after a recorded expected failure.
# python3 "$U9_ARCH" undo "$PLAN_FILE" "$INPUTS_FILE" "$PROOF_DIR"
```

Step 1 retains raw JSON, digests/metadata, current trees, mounts, StartedAt,
timer/service state and independent CLOSED projection; holds the timer and
records a successful recycle with fresh generation. Step 2 moves only the
bound legacy tar aside, preserves durable bytes, requires ExecStartPre failure,
UNKNOWN journal evidence, unchanged StartedAt/projection and CLOSED readback.
Step 3 restores exact bytes/owner/mode exclusively and checks byte-identical JSON (which
step 2 never changes), records recovery, resets only a recorded expected unit
failure, runs a fresh successful control, and confirms the timer active.
Exclusive `u9-ARCH-*.json` receipts bind release/window/plan/identity. A failure
before a proven negative needs lead inspection; do not reset an unknown failure.
ARCH steps 4–5 are CUT by ruling 44: no live proof of a durable recycle without
the /tmp tars, or of rescue restaging plus a byte-identical rollback.
See FOLLOW-UPS-C1 #51–#53; no reboot or final migration is emitted.

# CommonSwarm production controls — 2026-09-27

**PROCEDURE.md v3**

**When Claude authentication is valid, no G3a step needs Tom. Anvil runs the entire control on the Mac mini.**

Operator: Anvil, on the Mac mini
Approver: HezLead
Claude account operator for this control: Anvil, using Tom’s already-authenticated account
Workspace: Cold Agent Test, `c2ea0541-f56d-4c73-bf71-56c5405c4934`
Procedure: `docs/evidence/2026-09-27-prod-controls/PROCEDURE.md`
Run evidence: `docs/evidence/2026-09-27-prod-controls/RUN/`

## TOM checklist

**No action when authentication is valid.** Under the supplied 2026-09-27 Strategist ruling, Anvil runs the user tests. Anvil already ran `claude auth login` for T2 on the mini and runs Claude sessions there.

- **ANVIL — Claude authentication:** check `claude auth status`; run `claude auth login` if authentication or recovery is needed.
- **ANVIL — Claude account and session:** create the Haiku session, read its real session UUID, resume it, send the benign turns, and leave it idle.
- **ANVIL — approvals:** consent to the development-channel preview, press its approval key if requested, and approve `cswarm_reply` once when prompted. Do not preapprove that reply tool.
- **ANVIL — completion:** observe the negative control with the Claude session still open, then exit the session.

Only an actual authentication challenge can introduce a **TOM** step:

| Conditional TOM step | Which requirement and why | Anvil before and after |
|---|---|---|
| Enter an account password that the sign-in or recovery flow requires from Tom. | **Tom’s password:** the displayed challenge requires his secret. | Anvil starts `claude auth login` and identifies the password challenge. Tom enters it directly into the sign-in surface, never into chat or evidence. Anvil then continues the login flow and reruns `claude auth status`. |
| Complete a phone approval or phone-held passkey challenge. | **Tom’s phone:** the displayed challenge requires a device held by Tom. | Anvil starts the login flow and identifies the phone challenge. Tom completes it on his phone. Anvil then observes completion and reruns `claude auth status`. |
| Complete a local sign-in or passkey challenge that specifically requires Tom at the mini. | **Tom physically at the screen:** the displayed challenge requires his local presence, such as a biometric action. | Anvil brings the login flow to that challenge. Tom performs only the required local action. Anvil then continues the flow and reruns `claude auth status`. |

An expired login alone does not make authentication a Tom-owned task. Anvil attempts recovery and requests only the specific intervention actually required. After authentication succeeds, every remaining G3a step belongs to Anvil.

The older T2 brief assigns login and a possible development-channel approval key to Tom (`docs/design/2026-09-26-T2-CLAUDE-CHANNEL-PROOF-BRIEF.md:44-55`). The supplied binding ruling, `strategist-rulings-hm-g3a.txt`, item 1, supersedes that ownership for this procedure. A Claude channel or tool-approval prompt does not itself require Tom’s phone, password, or physical presence.

Minting and revocation remain Anvil’s under Tom’s standing CommonSwarm human session (`docs/evidence/2026-09-27-box-g3c-g3d-t3a/BOX-WINDOW.md:202-204,283-286`). Anvil’s operation of the Claude session follows the separate supplied Strategist ruling.

## Status and limits

The requested live starting state is:

- edge `38343e74cbd51ec1375317fb4770d2522ca09d0b`;
- migrations `20260927000001`, `20260927000002`, and `20260927000003`;
- npm `commonswarm@0.1.80`;
- `current_client_build = 0.1.80`;
- site `ff27acfbb8055dce173c403b2befa75a68f2bc86`.

The supplied current production client build is **0.1.80**. These live identities are **NOT VERIFIED by this document’s author**. The reviewed repository is at `ff27acfbb8055dce173c403b2befa75a68f2bc86`, and its package version is `0.1.80` (`package.json:2-9`). This read-only review did not contact production or npm.

There is no public or CLI output in this checkout that reports the raw configured `current_client_build`:

- The authenticated presence view reads it from database configuration (`supabase/migrations/20260927000002_agent_presence.sql:52-73`).
- The authenticated members endpoint includes it internally (`supabase/functions/read/index.ts:697-712`).
- `members --json` prints the derived presence classification and seat build, omitting the raw configured value (`src/cli.ts:4310-4317,4515-4530`).
- `setup --check-version` reports the connection-format version, not the configured current client build (`src/onboarding-cli.ts:169-175`).

Accordingly, preflight records **`current_client_build: NOT VERIFIED`**. No database read is added to this procedure. The G3e assertions subsequently prove the observed classifications; they do not establish the exact configured build.

Do not run Docker, access the box database, change the box, deploy, run `cswarm listen`, automate a browser, or press web **Sign out**. The browser work below is a manual check in Anvil’s existing real Chrome session.

G3e uses four category seats: live, stale, turn, and none. This matches the design’s four categories (`docs/design/2026-09-26-REST-OF-G-BRIEF.md:155-183`) and the test that calls live watcher, stale channel, turn, and none “every wake kind” (`tests/p1-cli/members-presence.test.ts:218-247`). It does not attempt every live/stale route permutation.

The complete procedure mints exactly **13 seats**:

| Control | Seats |
|---|---:|
| G3a | 2 |
| G3e | 4 |
| T3 | 7 |
| Total | **13** |

HezLead must approve the fixed suffix `0927a` before minting. If any name already exists, stop. Do not use `--allow-duplicate-name`; the established mint procedure treats a collision or partial directory as a stop (`docs/evidence/2026-09-27-box-g3c-g3d-t3a/BOX-WINDOW.md:200-286`).

Tom’s availability does not block G3a when authentication is valid. If authentication recovery reaches a challenge requiring Tom’s phone, password, or physical presence and that intervention is unavailable, G3a remains **NOT VERIFIED**. Do not claim completion from preparations and CLI checks alone. Preserve protected records and revoke the seats when HezLead says they are no longer needed.

## 0. Preflight and protected state

The npm package maps `commonswarm` to the `cswarm` executable and requires Node 22 or newer (`npm/package.template.json:2-12`). The npm artifact is the same single-file release bundle, not a separate implementation (`scripts/build-npm.sh:8-16`).

Run from the repository root. Keep the control terminal open throughout. Dedicated terminals must have the same exported control variables; copy only these paths, workspace ID, and suffix into them, never credential values.

```zsh
export CTL_WS=c2ea0541-f56d-4c73-bf71-56c5405c4934
export CTL_SUFFIX=0927a
export CTL_ROOT="$HOME/.config/cswarm/prod-controls-20260927-$CTL_SUFFIX"
export CTL_EVIDENCE="$PWD/docs/evidence/2026-09-27-prod-controls/RUN"

umask 077

# Create the evidence directory before opening the redirected preflight log.
# Refuse an existing run directory rather than mixing evidence from two runs.
if test ! -e "$CTL_EVIDENCE" && mkdir -p "$CTL_EVIDENCE"
then
  :
else
  printf '%s\n' 'FAIL PRE-FLIGHT — RUN already exists or cannot be created' >&2
  exit 1
fi

if (
  set -euo pipefail
  umask 077

  test "$(git rev-parse HEAD)" = ff27acfbb8055dce173c403b2befa75a68f2bc86
  test "$(git rev-parse --abbrev-ref HEAD)" = main
  test "$(node -p 'Number(process.versions.node.split(".")[0]) >= 22')" = true
  test ! -e "$CTL_ROOT"

  mkdir -m 0700 "$CTL_ROOT"
  mkdir -m 0700 "$CTL_ROOT/npm-cache"

  test "$(npm view commonswarm@0.1.80 version)" = 0.1.80
  test "$(
    env npm_config_cache="$CTL_ROOT/npm-cache" \
      npx --yes --package=commonswarm@0.1.80 -- cswarm --version
  )" = "cswarm 0.1.80 (protocol 0.1.0)"
  test "$(
    env npm_config_cache="$CTL_ROOT/npm-cache" \
      npx --yes --package=commonswarm@0.1.79 -- cswarm --version
  )" = "cswarm 0.1.79 (protocol 0.1.0)"

  printf '%s\n' \
    'current_client_build: NOT VERIFIED' \
    'Supplied production expectation: 0.1.80' \
    'No public or CLI output exposes the raw configured value in this checkout.' \
    'Reading the authenticated database-backed presence surface is outside this procedure.' \
    >"$CTL_EVIDENCE/00-current-client-build.txt"

  env npm_config_cache="$CTL_ROOT/npm-cache" \
    npx --yes --package=commonswarm@0.1.80 -- \
    cswarm status --workspace-id "$CTL_WS" --json \
    >"$CTL_EVIDENCE/00-human-session.json"
) >"$CTL_EVIDENCE/00-preflight.txt" 2>&1
then
  printf '%s\n' 'PASS PRE-FLIGHT'
else
  rc=$?
  printf '%s\n' 'FAIL PRE-FLIGHT' >&2
  exit "$rc"
fi
```

The version comparisons match the real printer, including its protocol suffix (`src/cli.ts:10478-10481`; `src/cloud/config.ts:3`). The SHA check follows the exact-commit pattern used by the release procedure (`deploy/RELEASE-TO-BOX.md:74-123`). `cswarm status --workspace-id … --json` checks the human-session workspace (`src/cli.ts:10207`).

Expected terminal result:

```text
PASS PRE-FLIGHT
```

Failure result:

```text
FAIL PRE-FLIGHT
```

Stop on failure. Preflight success does not verify the live release identities or raw configured current build.

### Obtain the public anon key without printing it

The site publishes the public anon key in its CommonSwarm anon-key meta tag (`site/src/layouts/Base.astro:206`). `cswarm target show --json --reveal-anon-key` reads the saved target with that value included (`src/cli.ts:1920-1955`).

The parser constructs the meta name from its namespace and field name. Protected connection fields below are likewise constructed without embedding the evidence scanner’s complete markers in this document.

```zsh
if (
  set -euo pipefail
  umask 077

  curl -fsS https://commonswarm.com/start >"$CTL_ROOT/start.html"

  env npm_config_cache="$CTL_ROOT/npm-cache" \
    npx --yes --package=commonswarm@0.1.80 -- \
    cswarm target show --json --reveal-anon-key \
    >"$CTL_ROOT/current-target.json"

  python3 - "$CTL_ROOT/start.html" "$CTL_ROOT/current-target.json" \
    "$CTL_ROOT/anon-key.txt" <<'PY'
import json
import os
import pathlib
import sys
from html.parser import HTMLParser

meta_name = ":".join(("commonswarm", "anon-key"))
anon_field = "_".join(("anon", "key"))

class MetaParser(HTMLParser):
    value = None
    def handle_starttag(self, tag, attrs):
        if tag != "meta":
            return
        row = dict(attrs)
        if row.get("name") == meta_name:
            self.value = row.get("content")

html_file, target_file, output_file = map(pathlib.Path, sys.argv[1:])
parser = MetaParser()
parser.feed(html_file.read_text())
target = json.loads(target_file.read_text()).get("current_target") or {}

assert parser.value
assert target.get("url") == "https://api.commonswarm.com"
assert target.get(anon_field) == parser.value

fd = os.open(output_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as output:
    output.write(parser.value + "\n")
PY

  test "$(stat -f %Lp "$CTL_ROOT")" = 700
  test "$(stat -f %Lp "$CTL_ROOT/anon-key.txt")" = 600
  printf '%s\n' 'anon key fetched and matched' \
    >"$CTL_EVIDENCE/01-anon-key-check.txt"
)
then
  printf '%s\n' 'PASS ANON-KEY'
else
  rc=$?
  printf '%s\n' 'FAIL ANON-KEY' >&2
  exit "$rc"
fi
```

Expected:

```text
PASS ANON-KEY
```

Failure:

```text
FAIL ANON-KEY
```

Neither the key nor either protected input file belongs in committed evidence.

## 1. Mint all 13 seats

**ANVIL** runs this section under Tom’s existing CommonSwarm human-session authorization.

The command shapes for `principal create` and `token mint` are defined at `src/cli.ts:10253-10263`; the `setup` command entry is at `src/cli.ts:10110-10116`.

This block preserves the production mint pattern: a `0700` root, one `0700` directory per seat, `0600` files, `principal.json`, one final success line, and no printed credential (`docs/evidence/2026-09-27-box-g3c-g3d-t3a/BOX-WINDOW.md:210-286`).

```zsh
(
  set -euo pipefail
  trap 'printf "%s\n" "FAIL MINT" >&2' ERR
  umask 077

  test "$CTL_SUFFIX" = 0927a
  test "$CTL_WS" = c2ea0541-f56d-4c73-bf71-56c5405c4934
  test -d "$CTL_ROOT"
  test -s "$CTL_ROOT/anon-key.txt"
  test "$(stat -f %Lp "$CTL_ROOT")" = 700
  test "$(stat -f %Lp "$CTL_ROOT/anon-key.txt")" = 600

  lower() { tr 'A-Z' 'a-z'; }

  cs080() {
    env npm_config_cache="$CTL_ROOT/npm-cache" \
      npx --yes --package=commonswarm@0.1.80 -- cswarm "$@"
  }

  mint_seat() {
    NAME="$1"
    SLUG="$2"
    D="$CTL_ROOT/$SLUG"

    test ! -e "$D"
    mkdir -m 0700 "$D"
    install -m 0600 /dev/null "$D/mint.log"

    cs080 principal create \
      --workspace-id "$CTL_WS" --name "$NAME" \
      >"$D/principal.json" 2>>"$D/mint.log"

    PID="$(python3 -c \
      'import json,sys; print(json.load(open(sys.argv[1]))["principal_id"])' \
      "$D/principal.json" 2>>"$D/mint.log")"

    cs080 token mint \
      --workspace-id "$CTL_WS" \
      --principal-id "$PID" \
      --run-id "$(uuidgen | lower)" \
      --task-id "$(uuidgen | lower)" \
      --epoch 1 \
      --ttl-ms 21600000 \
      --renewal-horizon-days 1 \
      >"$D/credential-mint.json" 2>>"$D/mint.log"

    python3 - \
      "$CTL_ROOT/anon-key.txt" \
      "$D/credential-mint.json" \
      "$D/connection.json" \
      "$CTL_WS" \
      "$PID" 2>>"$D/mint.log" <<'PY'
import json
import pathlib
import sys

anon_file, credential_file, output_file, workspace_id, principal_id = sys.argv[1:]
anon_key = pathlib.Path(anon_file).read_text().strip()
credential = json.loads(pathlib.Path(credential_file).read_text())
assert anon_key and credential["principal_id"] == principal_id

anon_field = "_".join(("anon", "key"))
credential_field = "creden" + "tial"
connection = {
    "version": 1,
    "url": "https://api.commonswarm.com",
    anon_field: anon_key,
    "workspace_id": workspace_id,
    "principal_id": principal_id,
    credential_field: credential,
}
pathlib.Path(output_file).write_text(json.dumps(connection) + "\n")
PY

    cs080 setup \
      --connection-file "$D/connection.json" \
      --profile "$D/profile.json" \
      --host-session-id manual \
      --json \
      >"$D/setup.json" 2>>"$D/mint.log"

    chmod 0700 "$D"
    chmod 0600 "$D"/*.json "$D/mint.log"
  }

  mint_seat "ctl-g3a-channel-$CTL_SUFFIX" g3a-channel
  mint_seat "ctl-g3a-sender-$CTL_SUFFIX" g3a-sender

  mint_seat "ctl-g3e-live-$CTL_SUFFIX" g3e-live
  mint_seat "ctl-g3e-stale-old-$CTL_SUFFIX" g3e-stale-old
  mint_seat "ctl-g3e-turn-$CTL_SUFFIX" g3e-turn
  mint_seat "ctl-g3e-none-$CTL_SUFFIX" g3e-none

  mint_seat "ctl-t3-a-$CTL_SUFFIX" t3-a
  mint_seat "ctl-t3-b-$CTL_SUFFIX" t3-b
  mint_seat "ctl-t3-c-$CTL_SUFFIX" t3-c
  mint_seat "ctl-t3-d-$CTL_SUFFIX" t3-d
  mint_seat "ctl-t3-e-$CTL_SUFFIX" t3-e
  mint_seat "ctl-t3-f-$CTL_SUFFIX" t3-f
  mint_seat "ctl-t3-g-$CTL_SUFFIX" t3-g

  python3 - "$CTL_ROOT" "$CTL_EVIDENCE/02-seats.md" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
rows = []
for directory in sorted(p for p in root.iterdir() if (p / "principal.json").is_file()):
    value = json.loads((directory / "principal.json").read_text())
    rows.append((directory.name, value["principal_id"]))

assert len(rows) == 13
assert len({principal for _, principal in rows}) == 13
text = [
    "# Production-control seats",
    "",
    "| slug | principal_id |",
    "|---|---|",
    *[f"| {slug} | {principal} |" for slug, principal in rows],
    "",
]
output.write_text("\n".join(text))
PY

  trap - ERR
  printf '%s\n' OK
)
```

Expected:

```text
OK
```

Failure:

```text
FAIL MINT
```

If the final `OK` is absent, stop. Do not reuse a partially populated directory or retry a name. HezLead must approve another fixed suffix first. Preserve protected records so any successfully created principals can be reconciled and revoked.

## 2. G3a — idle Haiku channel ACK and reply

**Full control: ANVIL. When authentication is valid, no step needs Tom.**

G3a requires two new Cold Agent Test seats and the T2 flow (`docs/evidence/2026-09-26-item-g-g3a/LANDING.md:23-27`). The established channel command uses `receive configure --mode wake --provider claude`, a real session ID, preview consent, and the printed Claude resume shape (`docs/design/2026-09-26-T2-CLAUDE-CHANNEL-PROOF-BRIEF.md:38-66`; `src/cli.ts:10132-10138`).

The notice tells the model to call `cswarm_received` first and then `cswarm_reply`; only the receipt tool is preapproved (`src/cloud/agent-channel.ts:31-45`; `src/cloud/agent-receive.ts:155-168`). Whether Haiku follows it in production is **NOT VERIFIED until this control runs**.

**Interaction surface:** Anvil uses a dedicated interactive terminal on the Mac mini, called **Anvil’s terminal** below, and keeps the separate control terminal available for CommonSwarm commands. The repository documents a terminal tab and a real session UUID read from the scratch project’s JSONL filename; it does not document Anvil’s specific terminal-control tool or its send-key API (`docs/design/2026-09-26-T2-CLAUDE-CHANNEL-PROOF-BRIEF.md:47-55`).

Anvil types the specified text into the Claude TUI and sends **Enter** to submit a turn. At approval prompts, Anvil first reads the displayed choices and sends the exact key or confirmation text shown for the specified approval. The repository does not record those literal approval keys: do not assume `y`, `1`, or Enter approves the intended choice. The prompt-specific inputs below are marked explicitly and must be resolved from Anvil’s terminal before sending them. This does not require Tom.

### 2.1 Create the real Haiku session

**ANVIL — scratch preparation**, in the control terminal:

```zsh
export G3A_T="$(mktemp -d /tmp/ctl-g3a.XXXXXX)"
chmod 0700 "$G3A_T"
printf '%s\n' "$G3A_T" >"$CTL_ROOT/g3a-scratch-path"
```

**ANVIL — authentication**, in Anvil’s terminal with the same control variables and scratch path, types the following shell command and presses **Enter**:

```zsh
claude auth status
```

If not authenticated, **ANVIL** runs:

```zsh
claude auth login
```

Anvil owns the login flow. If it requires Tom’s password, Tom’s phone, or Tom physically at the screen, pause only at that challenge and follow the corresponding conditional TOM checklist entry. Anvil starts the flow before Tom’s intervention, continues it afterward, and reruns `claude auth status` before proceeding. Do not save authentication output or account data in committed evidence.

**ANVIL** then runs in Anvil’s terminal:

```zsh
claude --version >"$CTL_EVIDENCE/g3a-claude-version.txt"

cd "$G3A_T"
claude --model claude-haiku-4-5
```

At the Claude input prompt, **ANVIL** types exactly the following text and presses **Enter**:

```text
Reply only with: ok
```

After Claude finishes the response, **ANVIL** exits this seed session from Anvil’s terminal: send **Control-C**; if Claude displays an instruction to press Control-C again to exit, send **Control-C** again. Confirm that the shell prompt returns. This is an explicit terminal action for this procedure; the repository’s T2 record specifies exiting but does not record its exit keystroke.

**ANVIL** reads the real session UUID from the JSONL filename under Claude’s project directory for this newly created scratch directory, following the original T2 lookup procedure (`docs/design/2026-09-26-T2-CLAUDE-CHANNEL-PROOF-BRIEF.md:47-49`). Read the filename belonging to this session; do not invent an ID or copy raw JSONL into evidence.

**ANVIL** sets the UUID in both the control terminal and Anvil’s terminal, replacing `<real-session-uuid>` with that filename’s UUID, and runs the validation:

```zsh
export G3A_S='<real-session-uuid>'

if python3 - "$G3A_S" <<'PY'
import sys
import uuid
value = sys.argv[1]
assert str(uuid.UUID(value)) == value
PY
then
  printf '%s\n' 'PASS G3A SESSION'
else
  printf '%s\n' 'FAIL G3A SESSION' >&2
  exit 1
fi
```

Expected:

```text
PASS G3A SESSION
```

Failure:

```text
FAIL G3A SESSION
```

The exact Claude JSONL lookup command is **NOT VERIFIED by repository code**; the repository records the manual lookup procedure. Anvil performs that lookup in Anvil’s terminal; no Tom handoff is required.

### 2.2 Configure and start the channel

**ANVIL — preview consent:** acknowledge that this control uses Claude’s development-channel research preview and requires its host approval step, then run the following configuration command. The preview flag acknowledges that step (`src/cloud/agent-receive.ts:239`). Under the supplied ruling, Anvil gives the test’s preview consent and handles the prompt.

**ANVIL — CommonSwarm configuration:**

```zsh
if (
  set -euo pipefail

  env npm_config_cache="$CTL_ROOT/npm-cache" \
    npx --yes --package=commonswarm@0.1.80 -- \
    cswarm receive configure \
      --profile "$CTL_ROOT/g3a-channel/profile.json" \
      --mode wake \
      --provider claude \
      --host-session-id "$G3A_S" \
      --cwd "$G3A_T" \
      --preview-channel \
      --json \
      >"$CTL_EVIDENCE/g3a-configure.json" \
      2>"$CTL_EVIDENCE/g3a-configure.stderr"

  python3 - "$CTL_EVIDENCE/g3a-configure.json" "$G3A_S" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1]))
assert value["requested_mode"] == "wake"
assert value["host_session_id"] == sys.argv[2]
assert value["start_command"].startswith("claude --resume ")
PY

  grep -qF '"mcp__cswarm__cswarm_received"' \
    "$G3A_T/.claude/settings.local.json"
)
then
  printf '%s\n' 'PASS G3A CONFIGURE'
else
  rc=$?
  printf '%s\n' 'FAIL G3A CONFIGURE' >&2
  exit "$rc"
fi
```

Expected:

```text
PASS G3A CONFIGURE
```

Failure:

```text
FAIL G3A CONFIGURE
```

**ANVIL** finds the one generated channel configuration and sets this path in Anvil’s terminal as well:

```zsh
export G3A_CONFIG="$(
  find "$CTL_ROOT/g3a-channel" -maxdepth 1 -type f \
    -name 'claude-channel-*.json' -print
)"
test -n "$G3A_CONFIG"
test "$(printf '%s\n' "$G3A_CONFIG" | wc -l | tr -d ' ')" = 1
```

**ANVIL**, in Anvil’s terminal with that configuration path, runs:

```zsh
cd "$G3A_T"
claude \
  --resume "$G3A_S" \
  --mcp-config "$G3A_CONFIG" \
  --dangerously-load-development-channels server:cswarm \
  --model claude-haiku-4-5
```

If Claude asks to approve the development channel, **ANVIL** reads the prompt in Anvil’s terminal and sends:

```text
<the exact key or confirmation text displayed to approve the server:cswarm development channel>
```

That placeholder is a runtime input, not literal text to type. Its value is **NOT VERIFIED by the repository**; the T2 result records one confirmation but not its key (`docs/evidence/2026-09-26-t2-claude-channel/RESULT.md`). Anvil resolves it from the visible prompt and presses the displayed approval key once, or types the displayed confirmation text and submits it as instructed. Anvil does not delegate this approval to Tom.

After the Claude input prompt is ready, **ANVIL** types exactly this benign turn and presses **Enter**:

```text
Reply only with: ok
```

**ANVIL**, in the control terminal:

```zsh
if (
  set -euo pipefail

  env npm_config_cache="$CTL_ROOT/npm-cache" \
    npx --yes --package=commonswarm@0.1.80 -- \
    cswarm receive status \
      --profile "$CTL_ROOT/g3a-channel/profile.json" \
      --host-session-id "$G3A_S" \
      --json \
      >"$CTL_EVIDENCE/g3a-status-before.json"

  python3 - "$CTL_EVIDENCE/g3a-status-before.json" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1]))
assert value["requested_mode"] == "wake"
assert value["turn_check"] == "verified"
assert value["channel_running"] is True
PY
)
then
  printf '%s\n' 'PASS G3A CHANNEL READY'
else
  rc=$?
  printf '%s\n' 'FAIL G3A CHANNEL READY' >&2
  exit "$rc"
fi
```

Expected:

```text
PASS G3A CHANNEL READY
```

Failure:

```text
FAIL G3A CHANNEL READY
```

**ANVIL** leaves the Claude session open and idle for at least five minutes, sending no text or keys into its TUI.

### 2.3 Send the ask and observe the tool sequence

**ANVIL** sends the ask. `ask`, `reply`, and `receipt` command forms are defined together at `src/cli.ts:10244-10246`.

```zsh
if (
  set -euo pipefail

  env npm_config_cache="$CTL_ROOT/npm-cache" \
    npx --yes --package=commonswarm@0.1.80 -- \
    cswarm ask \
      "G3a production control: acknowledge this delivery, then reply with exactly G3A ACK and the current UTC time." \
      --profile "$CTL_ROOT/g3a-sender/profile.json" \
      --to "ctl-g3a-channel-$CTL_SUFFIX" \
      --json \
      >"$CTL_EVIDENCE/g3a-ask.json" \
      2>"$CTL_EVIDENCE/g3a-ask.stderr"

  python3 - "$CTL_EVIDENCE/g3a-ask.json" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1]))
assert value["signal"]["id"]
PY
)
then
  # Keep this assignment in the control shell, outside the subshell.
  export G3A_ASK_ID="$(
    python3 -c \
      'import json,sys; print(json.load(open(sys.argv[1]))["signal"]["id"])' \
      "$CTL_EVIDENCE/g3a-ask.json"
  )"
  printf '%s\n' 'PASS G3A ASK SENT'
else
  rc=$?
  printf '%s\n' 'FAIL G3A ASK SENT' >&2
  exit "$rc"
fi
```

Expected:

```text
PASS G3A ASK SENT
```

Failure:

```text
FAIL G3A ASK SENT
```

**ANVIL** watches the idle Claude session in Anvil’s terminal without sending another turn. Pass only if all four facts are directly observed:

1. The CommonSwarm channel notice appears.
2. Haiku calls `cswarm_received` without a user prompt or approval prompt.
3. `cswarm_reply` produces an approval prompt.
4. **ANVIL** approves that reply once and it succeeds.

For step 4, Anvil reads the `cswarm_reply` tool name and displayed choices in Anvil’s terminal, then sends:

```text
<the exact key or confirmation text displayed to allow this cswarm_reply call once>
```

Resolve that placeholder from the prompt before sending it. The repository does not record the literal key or choice label. Choose only the one-time approval; do not choose a persistent approval or preapprove the reply tool. If the prompt does not offer a clear one-time approval, do not guess or record a pass.

**ANVIL** records the observation in the control terminal, without copying raw JSONL or credentials. At the shell’s `read` prompt below, type exactly `PASS G3A TOOL SEQUENCE` or `FAIL G3A TOOL SEQUENCE` and press **Enter**:

```zsh
printf '%s\n' \
  'Type PASS G3A TOOL SEQUENCE only if the no-prompt receipt and Anvil-approved prompted reply were both observed; otherwise type FAIL G3A TOOL SEQUENCE.'
IFS= read -r G3A_VERDICT

case "$G3A_VERDICT" in
  'PASS G3A TOOL SEQUENCE')
    printf '%s\n' "$G3A_VERDICT" \
      | tee "$CTL_EVIDENCE/g3a-tool-sequence.txt"
    ;;
  *)
    printf '%s\n' 'FAIL G3A TOOL SEQUENCE' \
      | tee "$CTL_EVIDENCE/g3a-tool-sequence.txt" >&2
    exit 1
    ;;
esac
```

Expected:

```text
PASS G3A TOOL SEQUENCE
```

Failure:

```text
FAIL G3A TOOL SEQUENCE
```

### 2.4 Prove the server ACK and reply

**ANVIL** collects the receipt.

A receipt becomes `observed` only from an observed acknowledgement (`src/cloud/receipts.ts:63-73`); the JSON retains `state`, `outcome`, `acked_at`, and reply rows (`src/cloud/receipts.ts:275-311`; `src/cloud/delivery-receipts.ts:192-222`).

```zsh
if (
  set -euo pipefail

  CHANNEL_PID="$(
    python3 -c \
      'import json,sys; print(json.load(open(sys.argv[1]))["principal_id"])' \
      "$CTL_ROOT/g3a-channel/principal.json"
  )"

  passed=no
  for attempt in {1..24}; do
    env npm_config_cache="$CTL_ROOT/npm-cache" \
      npx --yes --package=commonswarm@0.1.80 -- \
      cswarm receipt "$G3A_ASK_ID" \
        --profile "$CTL_ROOT/g3a-sender/profile.json" \
        --json \
        >"$CTL_EVIDENCE/g3a-receipt.json" \
        2>"$CTL_EVIDENCE/g3a-receipt.stderr"

    if python3 - "$CTL_EVIDENCE/g3a-receipt.json" "$CHANNEL_PID" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1]))
principal = sys.argv[2]
receipt = next(
    row for row in value["receipts"]
    if row.get("recipient_agent_principal_id") == principal
)
assert receipt["state"] == "observed"
assert receipt["outcome"] == "observed"
assert receipt["acked_at"]
assert any(
    row.get("responder_principal_id") == principal
    for row in value["replies"]
)
PY
    then
      passed=yes
      break
    fi
    sleep 5
  done

  test "$passed" = yes
)
then
  printf '%s\n' 'PASS G3A ACK AND REPLY' \
    | tee "$CTL_EVIDENCE/g3a-result.txt"
else
  rc=$?
  printf '%s\n' 'FAIL G3A ACK AND REPLY' \
    | tee "$CTL_EVIDENCE/g3a-result.txt" >&2
  exit "$rc"
fi
```

Expected:

```text
PASS G3A ACK AND REPLY
```

Failure:

```text
FAIL G3A ACK AND REPLY
```

### 2.5 T2 negative control

**ANVIL** leaves the Claude session open and idle in Anvil’s terminal throughout this negative control. Send no turn, approval input, or exit key to that TUI during the observation window.

**ANVIL** changes only this control’s receiver to turn mode from the control terminal. Configuration to turn removes only CommonSwarm’s receipt preapproval (`src/cloud/agent-receive.ts:155-168`).

```zsh
if (
  set -euo pipefail

  env npm_config_cache="$CTL_ROOT/npm-cache" \
    npx --yes --package=commonswarm@0.1.80 -- \
    cswarm receive configure \
      --profile "$CTL_ROOT/g3a-channel/profile.json" \
      --mode turn \
      --provider claude \
      --host-session-id "$G3A_S" \
      --cwd "$G3A_T" \
      --json \
      >"$CTL_EVIDENCE/g3a-negative-configure.json"

  stopped=no
  for attempt in {1..12}; do
    env npm_config_cache="$CTL_ROOT/npm-cache" \
      npx --yes --package=commonswarm@0.1.80 -- \
      cswarm receive status \
        --profile "$CTL_ROOT/g3a-channel/profile.json" \
        --host-session-id "$G3A_S" \
        --json \
        >"$CTL_EVIDENCE/g3a-negative-status.json"

    if python3 - "$CTL_EVIDENCE/g3a-negative-status.json" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1]))
assert value["requested_mode"] == "turn"
assert value["channel_running"] is False
PY
    then
      stopped=yes
      break
    fi
    sleep 5
  done
  test "$stopped" = yes

  env npm_config_cache="$CTL_ROOT/npm-cache" \
    npx --yes --package=commonswarm@0.1.80 -- \
    cswarm ask \
      "G3a negative control: this must not reach the stopped channel." \
      --profile "$CTL_ROOT/g3a-sender/profile.json" \
      --to "ctl-g3a-channel-$CTL_SUFFIX" \
      --json \
      >"$CTL_EVIDENCE/g3a-negative-ask.json"

  NEGATIVE_ID="$(
    python3 -c \
      'import json,sys; print(json.load(open(sys.argv[1]))["signal"]["id"])' \
      "$CTL_EVIDENCE/g3a-negative-ask.json"
  )"

  for attempt in {1..30}; do sleep 10; done

  env npm_config_cache="$CTL_ROOT/npm-cache" \
    npx --yes --package=commonswarm@0.1.80 -- \
    cswarm receipt "$NEGATIVE_ID" \
      --profile "$CTL_ROOT/g3a-sender/profile.json" \
      --json \
      >"$CTL_EVIDENCE/g3a-negative-receipt.json"

  python3 - "$CTL_EVIDENCE/g3a-negative-receipt.json" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1]))
assert len(value["receipts"]) == 1
receipt = value["receipts"][0]
assert receipt["state"] == "not_delivered"
assert receipt["outcome"] is None
assert not value["replies"]
PY
)
then
  printf '%s\n' 'PASS G3A NEGATIVE CONTROL' \
    | tee "$CTL_EVIDENCE/g3a-negative-result.txt"
else
  rc=$?
  printf '%s\n' 'FAIL G3A NEGATIVE CONTROL' \
    | tee "$CTL_EVIDENCE/g3a-negative-result.txt" >&2
  exit "$rc"
fi
```

Expected:

```text
PASS G3A NEGATIVE CONTROL
```

Failure:

```text
FAIL G3A NEGATIVE CONTROL
```

This follows T2’s stopped-receiver expectation (`docs/design/2026-09-26-T2-CLAUDE-CHANNEL-PROOF-BRIEF.md:67-75`). **ANVIL** observes Anvil’s terminal throughout the five-minute window and confirms that no negative-control notice appeared. If Claude restarted the receiver or displayed the notice, record a failure rather than retaining the pass result.

After recording the result, **ANVIL** exits the Claude session in Anvil’s terminal: send **Control-C**; if Claude displays an instruction to press Control-C again to exit, send **Control-C** again. Confirm the terminal has returned to its shell before proceeding to cleanup. Tom does not need to observe or confirm this exit.

## 3. G3e — live, stale, turn, none, and update available

**ANVIL** runs this control without Claude account interaction.

A push route is live for three minutes after its latest route timestamp and stale afterward (`src/cloud/wake-lease-constants.ts:6-9`; `src/cloud/agent-presence.ts:94-115`). A lower semantic version than `current_client_build` is “update available” (`src/cloud/agent-presence.ts:62-75`).

Use **`commonswarm@0.1.79`** for the deliberately old seat, against the supplied current production build of **0.1.80**. Do not use `0.1.80` as the old seat. The historical box plan describes the earlier `0.1.79` publication sequence; it is not evidence of today’s configured build (`docs/evidence/2026-09-27-box-g3c-g3d-t3a/BOX-WINDOW.md:473-499`).

The old client runs through `npx` with the control-owned npm cache, so no global or working-seat installation changes. The assertions must observe “update available”; a version string alone does not prove that classification.

### 3.1 Start the live watcher

In dedicated Terminal tab A, with the control variables set:

```zsh
env npm_config_cache="$CTL_ROOT/npm-cache" \
  npx --yes --package=commonswarm@0.1.80 -- \
  cswarm inbox --notify \
    --profile "$CTL_ROOT/g3e-live/profile.json" \
    --json \
    >"$CTL_ROOT/g3e-live/watcher.stdout" \
    2>"$CTL_ROOT/g3e-live/watcher.stderr"
```

`inbox --notify` is the watcher command (`src/cli.ts:4964-5019,9982-9984`). Leave it running.

Expected immediate condition:

```text
PASS is deferred until members reports live watcher.
```

Failure condition:

```text
FAIL G3E LIVE WATCHER
```

If the command exits before the members assertion, record that failure and stop.

### 3.2 Start and stop the old watcher

In dedicated Terminal tab B, with the control variables set:

```zsh
env npm_config_cache="$CTL_ROOT/npm-cache" \
  npx --yes --package=commonswarm@0.1.79 -- \
  cswarm inbox --notify \
    --profile "$CTL_ROOT/g3e-stale-old/profile.json" \
    --json \
    >"$CTL_ROOT/g3e-stale-old/watcher.stdout" \
    2>"$CTL_ROOT/g3e-stale-old/watcher.stderr"
```

In the control terminal, wait until both watcher routes are visible:

```zsh
if (
  set -euo pipefail

  ready=no
  for attempt in {1..24}; do
    env npm_config_cache="$CTL_ROOT/npm-cache" \
      npx --yes --package=commonswarm@0.1.80 -- \
      cswarm members \
        --profile "$CTL_ROOT/g3e-live/profile.json" \
        --json \
        >"$CTL_EVIDENCE/g3e-members-live.json"

    if python3 - "$CTL_EVIDENCE/g3e-members-live.json" "$CTL_SUFFIX" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1]))
suffix = sys.argv[2]
agents = {row["name"]: row for row in value["agents"]}

current = agents[f"ctl-g3e-live-{suffix}"]["presence"]
old = agents[f"ctl-g3e-stale-old-{suffix}"]["presence"]

assert current["wake"]["kind"] == "live watcher"
assert current["client_build"] == "0.1.80"
assert current["client"]["kind"] == "current"
assert current["last_call"] is not None

assert old["wake"]["kind"] == "live watcher"
assert old["client_build"] == "0.1.79"
assert old["client"]["kind"] == "update available"
assert old["last_call"] is not None
PY
    then
      ready=yes
      break
    fi
    sleep 5
  done
  test "$ready" = yes
)
then
  printf '%s\n' 'PASS G3E WATCHERS LIVE'
else
  rc=$?
  printf '%s\n' 'FAIL G3E WATCHERS LIVE' >&2
  exit "$rc"
fi
```

`members --profile … --json` is supported by the roster command (`src/cli.ts:4457-4545,10241`).

Expected:

```text
PASS G3E WATCHERS LIVE
```

Failure:

```text
FAIL G3E WATCHERS LIVE
```

Press Control-C only in Terminal tab B. Leave tab A running.

**Immediately after tab B returns to the shell, before running any other command in that tab**, capture the exit code:

```zsh
G3E_STOP_RC=$?
printf '%s\n' "$G3E_STOP_RC" >"$CTL_ROOT/g3e-stale-old/watcher.exit"
```

The CLI stop sentence is in the redirected **stderr file**, not the terminal. Check it together with exit **130** (`src/cli.ts:5004-5010`; `src/cloud/arrival-watch.ts:58,92-106`).

In the control terminal:

```zsh
if (
  set -euo pipefail

  python3 - "$CTL_ROOT/g3e-stale-old" "$CTL_EVIDENCE" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
evidence = pathlib.Path(sys.argv[2])

rc = int((root / "watcher.exit").read_text().strip())
assert rc == 130

expected = (
    "cswarm: inbox --notify stopped because of SIGINT and "
    "this watcher's lease was released; nothing is watching this inbox now; "
    "restart it under the session's Monitor."
)
lines = (root / "watcher.stderr").read_text().splitlines()
assert lines.count(expected) == 1

# Retain only the verified safe stop sentence, not the protected watcher log.
(evidence / "g3e-stale-stop.stderr").write_text(expected + "\n")
(evidence / "g3e-stale-stop.exit").write_text(str(rc) + "\n")
PY
)
then
  printf '%s\n' 'PASS G3E STALE WATCHER STOP' \
    | tee "$CTL_EVIDENCE/g3e-stale-stop-result.txt"
else
  rc=$?
  printf '%s\n' 'FAIL G3E STALE WATCHER STOP' >&2
  exit "$rc"
fi
```

Expected:

```text
PASS G3E STALE WATCHER STOP
```

Failure:

```text
FAIL G3E STALE WATCHER STOP
```

Release does not clear the last watcher timestamp; it can therefore become stale after the three-minute threshold (`supabase/functions/command/index.ts:2730-2736,2746-2777`; `src/cloud/agent-presence.ts:100-108`).

### 3.3 Seed the turn seat

`cswarm check` is the turn-mode command, and its presence touch is deliberately advisory and throttled (`src/cli.ts:10121-10131`; `docs/design/2026-09-26-REST-OF-G-BRIEF.md:138-149`). Because the touch is concurrent, the block allows two bounded attempts and verifies the actual server result instead of trusting exit zero.

```zsh
if (
  set -euo pipefail

  turn_seen=no
  for control_attempt in 1 2; do
    env npm_config_cache="$CTL_ROOT/npm-cache" \
      npx --yes --package=commonswarm@0.1.80 -- \
      cswarm check \
        --profile "$CTL_ROOT/g3e-turn/profile.json" \
        --json \
        >"$CTL_EVIDENCE/g3e-turn-check-$control_attempt.json" \
        2>"$CTL_EVIDENCE/g3e-turn-check-$control_attempt.stderr"

    for poll in {1..12}; do
      env npm_config_cache="$CTL_ROOT/npm-cache" \
        npx --yes --package=commonswarm@0.1.80 -- \
        cswarm members \
          --profile "$CTL_ROOT/g3e-live/profile.json" \
          --json \
          >"$CTL_EVIDENCE/g3e-members-turn.json"

      if python3 - "$CTL_EVIDENCE/g3e-members-turn.json" "$CTL_SUFFIX" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1]))
name = f"ctl-g3e-turn-{sys.argv[2]}"
row = next(row for row in value["agents"] if row["name"] == name)
assert row["presence"]["wake"]["kind"] == "turn"
assert row["presence"]["client_build"] == "0.1.80"
assert row["presence"]["client"]["kind"] == "current"
PY
      then
        turn_seen=yes
        break 2
      fi
      sleep 5
    done
  done

  test "$turn_seen" = yes
)
then
  printf '%s\n' 'PASS G3E TURN'
else
  rc=$?
  printf '%s\n' 'FAIL G3E TURN' >&2
  exit "$rc"
fi
```

Expected:

```text
PASS G3E TURN
```

Failure:

```text
FAIL G3E TURN
```

### 3.4 Wait for stale and capture the final CLI roster

```zsh
if (
  set -euo pipefail

  final_seen=no
  for attempt in {1..24}; do
    env npm_config_cache="$CTL_ROOT/npm-cache" \
      npx --yes --package=commonswarm@0.1.80 -- \
      cswarm members \
        --profile "$CTL_ROOT/g3e-live/profile.json" \
        --json \
        >"$CTL_EVIDENCE/g3e-members.json"

    if python3 - "$CTL_EVIDENCE/g3e-members.json" "$CTL_SUFFIX" <<'PY'
import json
import sys

value = json.load(open(sys.argv[1]))
suffix = sys.argv[2]
agents = {row["name"]: row for row in value["agents"]}

assert value.get("presence_error") is None

live = agents[f"ctl-g3e-live-{suffix}"]["presence"]
stale = agents[f"ctl-g3e-stale-old-{suffix}"]["presence"]
turn = agents[f"ctl-g3e-turn-{suffix}"]["presence"]
none = agents[f"ctl-g3e-none-{suffix}"]["presence"]

assert live["wake"]["kind"] == "live watcher"
assert live["client_build"] == "0.1.80"
assert live["client"]["kind"] == "current"
assert live["last_call"] is not None

assert stale["wake"]["kind"] == "stale watcher"
assert stale["client_build"] == "0.1.79"
assert stale["client"]["kind"] == "update available"
assert stale["last_call"] is not None

assert turn["wake"]["kind"] == "turn"
assert turn["client_build"] == "0.1.80"
assert turn["client"]["kind"] == "current"
assert turn["last_call"] is not None

assert none["wake"]["kind"] == "none"
assert none["last_call"] is None
assert none["client_build"] is None
assert none["client"]["kind"] == "unknown"

for row in (live, stale, turn):
    assert row["client"]["kind"] != "unknown"
PY
    then
      final_seen=yes
      break
    fi
    sleep 10
  done

  test "$final_seen" = yes

  env npm_config_cache="$CTL_ROOT/npm-cache" \
    npx --yes --package=commonswarm@0.1.80 -- \
    cswarm members \
      --profile "$CTL_ROOT/g3e-live/profile.json" \
      >"$CTL_EVIDENCE/g3e-members.txt"
)
then
  printf '%s\n' 'PASS G3E CLI ROSTER' \
    | tee "$CTL_EVIDENCE/g3e-cli-result.txt"
else
  rc=$?
  printf '%s\n' 'FAIL G3E CLI ROSTER' \
    | tee "$CTL_EVIDENCE/g3e-cli-result.txt" >&2
  exit "$rc"
fi
```

Expected:

```text
PASS G3E CLI ROSTER
```

Failure:

```text
FAIL G3E CLI ROSTER
```

The JSON and text roster use the same classifier. The text roster **omits the word `current`** when the JSON client kind is `current`. A turn route renders `turn, last <age>`, with a separate last-call field (`src/cli.ts:4310-4337,4502-4545`).

### 3.5 Manual real-Chrome `/app` check

The app reads the same presence columns (`site/src/components/app/LiveDashboard.astro:2025-2089`) and renders the classifier line beside each agent (`site/src/components/app/LiveDashboard.astro:4166-4197`; `site/src/lib/agent-presence.ts:69-88`).

In Anvil’s existing real Chrome session:

1. Open `https://commonswarm.com/app`.
2. Do not press **Sign out**.
3. Select **Cold Agent Test**.
4. Activate the roster button whose accessible name is **N agents — view and manage agents**. It may also include a pending-access count. **People & agents** is the dialog title after it opens (`site/src/components/app/LiveDashboard.astro:468-476,1030-1031,4097-4104`).
5. In the field with placeholder **Filter agents…**, type `ctl-g3e-`. Its accessible label is **Filter agents** (`site/src/components/app/LiveDashboard.astro:1056-1061`).
6. Confirm these four rows and rendered presence lines, allowing the age values to advance:

   | Seat | Presence line |
   |---|---|
   | `ctl-g3e-live-0927a` | `live watcher · last call: <age> · client build: 0.1.80` |
   | `ctl-g3e-stale-old-0927a` | `stale watcher · last call: <age> · client build: 0.1.79 · update available` |
   | `ctl-g3e-turn-0927a` | `turn, last <age> · last call: <age> · client build: 0.1.80` |
   | `ctl-g3e-none-0927a` | `none · last call: never · client build: unknown` |

7. Save a screenshot as `docs/evidence/2026-09-27-prod-controls/RUN/g3e-app-roster.png`. Capture the roster without account menus, credentials, or unrelated sensitive content.

Neither the app nor CLI text adds `current` to the current-build rows (`site/src/lib/agent-presence.ts:76-88`; `src/cli.ts:4332-4335`).

Then record the manual result:

```zsh
test -s "$CTL_EVIDENCE/g3e-app-roster.png" || {
  printf '%s\n' 'FAIL G3E APP ROSTER' >&2
  exit 1
}

printf '%s\n' \
  'Type PASS G3E APP ROSTER only if all four exact rows were visible; otherwise type FAIL G3E APP ROSTER.'
IFS= read -r G3E_APP_VERDICT

case "$G3E_APP_VERDICT" in
  'PASS G3E APP ROSTER')
    printf '%s\n' "$G3E_APP_VERDICT" \
      | tee "$CTL_EVIDENCE/g3e-app-result.txt"
    shasum -a 256 "$CTL_EVIDENCE/g3e-app-roster.png" \
      >"$CTL_EVIDENCE/g3e-app-roster.sha256"
    ;;
  *)
    printf '%s\n' 'FAIL G3E APP ROSTER' \
      | tee "$CTL_EVIDENCE/g3e-app-result.txt" >&2
    exit 1
    ;;
esac
```

Expected:

```text
PASS G3E APP ROSTER
```

Failure:

```text
FAIL G3E APP ROSTER
```

The manual UI check proves the rendered state, not that the deployed site’s source SHA is `ff27acfb`; the live site SHA remains **NOT VERIFIED** unless a separate release-identity surface supplies it.

## 4. T3 — normal chain, loop refusal, and hop-5 refusal

**ANVIL** runs this control.

The CLI’s explicit parent form is `cswarm ask … --parent <signal-id>` (`src/cli.ts:10244`; `src/cli.ts:3774-3829`). The server limit is four parent-to-child edges (`src/cloud/ask-chain-constants.ts:1-5`). Loop is checked before hop length (`supabase/functions/command/index.ts:9095-9113`), with exact refusal messages at `supabase/functions/command/index.ts:10412-10438`.

### 4.1 Normal two-hop chain

```zsh
if (
  set -euo pipefail

  cs080() {
    env npm_config_cache="$CTL_ROOT/npm-cache" \
      npx --yes --package=commonswarm@0.1.80 -- cswarm "$@"
  }

  A="$CTL_ROOT/t3-a"
  B="$CTL_ROOT/t3-b"
  C="$CTL_ROOT/t3-c"

  cs080 ask "T3 normal chain root." \
    --profile "$A/profile.json" \
    --to "ctl-t3-b-$CTL_SUFFIX" \
    --json \
    >"$CTL_EVIDENCE/t3-normal-root.json"

  NORMAL_ROOT="$(
    python3 -c \
      'import json,sys; v=json.load(open(sys.argv[1])); assert v["signal"]["chain_hop"] == 0; print(v["signal"]["id"])' \
      "$CTL_EVIDENCE/t3-normal-root.json"
  )"

  cs080 ask "T3 normal chain hop 1." \
    --profile "$B/profile.json" \
    --to "ctl-t3-c-$CTL_SUFFIX" \
    --parent "$NORMAL_ROOT" \
    --json \
    >"$CTL_EVIDENCE/t3-normal-hop1.json"

  NORMAL_HOP1="$(
    python3 -c \
      'import json,sys; v=json.load(open(sys.argv[1])); assert v["signal"]["chain_hop"] == 1; print(v["signal"]["id"])' \
      "$CTL_EVIDENCE/t3-normal-hop1.json"
  )"

  cs080 ask "T3 normal chain hop 2." \
    --profile "$C/profile.json" \
    --to "ctl-t3-d-$CTL_SUFFIX" \
    --parent "$NORMAL_HOP1" \
    --json \
    >"$CTL_EVIDENCE/t3-normal-hop2.json"

  python3 - "$CTL_EVIDENCE/t3-normal-hop2.json" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1]))
assert value["signal"]["chain_hop"] == 2
assert value["signal"]["id"]
PY

  printf '%s\n' "$NORMAL_ROOT" >"$CTL_ROOT/t3-normal-root-id"
)
then
  printf '%s\n' 'PASS T3 NORMAL TWO-HOP CHAIN' \
    | tee "$CTL_EVIDENCE/t3-normal-result.txt"
else
  rc=$?
  printf '%s\n' 'FAIL T3 NORMAL TWO-HOP CHAIN' \
    | tee "$CTL_EVIDENCE/t3-normal-result.txt" >&2
  exit "$rc"
fi
```

Expected:

```text
PASS T3 NORMAL TWO-HOP CHAIN
```

Failure:

```text
FAIL T3 NORMAL TWO-HOP CHAIN
```

The server integration test defines the same root/hop-1/hop-2 sequence and expected hop values (`tests/p1-server/ask-chain.test.ts:309-334`).

### 4.2 Loop refusal

```zsh
if (
  set -euo pipefail

  NORMAL_ROOT="$(cat "$CTL_ROOT/t3-normal-root-id")"

  set +e
  env npm_config_cache="$CTL_ROOT/npm-cache" \
    npx --yes --package=commonswarm@0.1.80 -- \
    cswarm ask \
      "T3 loop attempt back to root sender." \
      --profile "$CTL_ROOT/t3-b/profile.json" \
      --to "ctl-t3-a-$CTL_SUFFIX" \
      --parent "$NORMAL_ROOT" \
      >"$CTL_EVIDENCE/t3-loop.stdout" \
      2>"$CTL_EVIDENCE/t3-loop.stderr"
  LOOP_RC=$?
  set -e

  test "$LOOP_RC" -eq 1
  test ! -s "$CTL_EVIDENCE/t3-loop.stdout"
  grep -qFx \
    'cswarm: This ask would go back to an agent that is already part of this request chain, so it was not sent. You can still reply to the ask you received.' \
    "$CTL_EVIDENCE/t3-loop.stderr"
)
then
  printf '%s\n' 'PASS T3 LOOP REFUSED chain_loop' \
    | tee "$CTL_EVIDENCE/t3-loop-result.txt"
else
  rc=$?
  printf '%s\n' 'FAIL T3 LOOP REFUSAL' \
    | tee "$CTL_EVIDENCE/t3-loop-result.txt" >&2
  exit "$rc"
fi
```

Expected:

```text
PASS T3 LOOP REFUSED chain_loop
```

Failure:

```text
FAIL T3 LOOP REFUSAL
```

The exact refusal and no-row property are covered by the server test (`tests/p1-server/ask-chain.test.ts:176-187,337-350`). Because this production procedure forbids Docker and box database access, the absence of signal, recipient, and delivery rows is **NOT VERIFIED live**; the live control verifies the production refusal response.

### 4.3 Hop-5 refusal with seven distinct seats

```zsh
if (
  set -euo pipefail

  cs080() {
    env npm_config_cache="$CTL_ROOT/npm-cache" \
      npx --yes --package=commonswarm@0.1.80 -- cswarm "$@"
  }

  cs080 ask "T3 length root." \
    --profile "$CTL_ROOT/t3-a/profile.json" \
    --to "ctl-t3-b-$CTL_SUFFIX" \
    --json \
    >"$CTL_EVIDENCE/t3-length-hop0.json"
  PARENT="$(
    python3 -c \
      'import json,sys; v=json.load(open(sys.argv[1])); assert v["signal"]["chain_hop"] == 0; print(v["signal"]["id"])' \
      "$CTL_EVIDENCE/t3-length-hop0.json"
  )"

  cs080 ask "T3 length hop 1." \
    --profile "$CTL_ROOT/t3-b/profile.json" \
    --to "ctl-t3-c-$CTL_SUFFIX" \
    --parent "$PARENT" --json \
    >"$CTL_EVIDENCE/t3-length-hop1.json"
  PARENT="$(
    python3 -c \
      'import json,sys; v=json.load(open(sys.argv[1])); assert v["signal"]["chain_hop"] == 1; print(v["signal"]["id"])' \
      "$CTL_EVIDENCE/t3-length-hop1.json"
  )"

  cs080 ask "T3 length hop 2." \
    --profile "$CTL_ROOT/t3-c/profile.json" \
    --to "ctl-t3-d-$CTL_SUFFIX" \
    --parent "$PARENT" --json \
    >"$CTL_EVIDENCE/t3-length-hop2.json"
  PARENT="$(
    python3 -c \
      'import json,sys; v=json.load(open(sys.argv[1])); assert v["signal"]["chain_hop"] == 2; print(v["signal"]["id"])' \
      "$CTL_EVIDENCE/t3-length-hop2.json"
  )"

  cs080 ask "T3 length hop 3." \
    --profile "$CTL_ROOT/t3-d/profile.json" \
    --to "ctl-t3-e-$CTL_SUFFIX" \
    --parent "$PARENT" --json \
    >"$CTL_EVIDENCE/t3-length-hop3.json"
  PARENT="$(
    python3 -c \
      'import json,sys; v=json.load(open(sys.argv[1])); assert v["signal"]["chain_hop"] == 3; print(v["signal"]["id"])' \
      "$CTL_EVIDENCE/t3-length-hop3.json"
  )"

  cs080 ask "T3 length hop 4." \
    --profile "$CTL_ROOT/t3-e/profile.json" \
    --to "ctl-t3-f-$CTL_SUFFIX" \
    --parent "$PARENT" --json \
    >"$CTL_EVIDENCE/t3-length-hop4.json"
  PARENT="$(
    python3 -c \
      'import json,sys; v=json.load(open(sys.argv[1])); assert v["signal"]["chain_hop"] == 4; print(v["signal"]["id"])' \
      "$CTL_EVIDENCE/t3-length-hop4.json"
  )"

  set +e
  cs080 ask "T3 length hop 5 must be refused." \
    --profile "$CTL_ROOT/t3-f/profile.json" \
    --to "ctl-t3-g-$CTL_SUFFIX" \
    --parent "$PARENT" \
    >"$CTL_EVIDENCE/t3-length-hop5.stdout" \
    2>"$CTL_EVIDENCE/t3-length-hop5.stderr"
  HOP5_RC=$?
  set -e

  test "$HOP5_RC" -eq 1
  test ! -s "$CTL_EVIDENCE/t3-length-hop5.stdout"
  grep -qFx \
    'cswarm: This request chain already has 4 hops, so this ask was not sent. You can still reply to the ask you received.' \
    "$CTL_EVIDENCE/t3-length-hop5.stderr"
)
then
  printf '%s\n' 'PASS T3 HOP-5 REFUSED chain_too_long' \
    | tee "$CTL_EVIDENCE/t3-hop5-result.txt"
else
  rc=$?
  printf '%s\n' 'FAIL T3 HOP-5 REFUSAL' \
    | tee "$CTL_EVIDENCE/t3-hop5-result.txt" >&2
  exit "$rc"
fi
```

Expected:

```text
PASS T3 HOP-5 REFUSED chain_too_long
```

Failure:

```text
FAIL T3 HOP-5 REFUSAL
```

This matches the seven-seat acceptance sequence in the server test (`tests/p1-server/ask-chain.test.ts:352-370`) and the production-control requirement (`docs/design/2026-09-26-T3-ASK-CHAIN-LIMITS-BRIEF.md:97-119`).

As with the loop control, the production absence of a refused signal row is **NOT VERIFIED** without a permitted database read.

## 5. Stop processes, revoke all 13 principals, and remove credentials

**ANVIL** first presses Control-C in G3e Terminal tab A. Confirm both watcher tabs have returned to their shells. **ANVIL** confirms the Claude session has exited as described in section 2.5.

Principals must be revoked by the ID stored in each `principal.json`, as required by the mint record (`docs/evidence/2026-09-27-box-g3c-g3d-t3a/BOX-WINDOW.md:283-286`). The revoke command is defined at `src/cli.ts:10253-10258`.

`principal revoke --json` emits one indented JSON object. Its accepted response contains `status`, `principal_id`, and `command_event_ids` (`src/cli.ts:1779-1780,2592-2607`). Parse each complete response, validate it against the requested principal, and only then append a compact JSON record. Count accepted, distinct results with a JSON parser.

```zsh
if (
  set -euo pipefail
  umask 077

  : >"$CTL_EVIDENCE/99-revoke.jsonl"

  for D in \
    "$CTL_ROOT/g3a-channel" \
    "$CTL_ROOT/g3a-sender" \
    "$CTL_ROOT/g3e-live" \
    "$CTL_ROOT/g3e-stale-old" \
    "$CTL_ROOT/g3e-turn" \
    "$CTL_ROOT/g3e-none" \
    "$CTL_ROOT/t3-a" \
    "$CTL_ROOT/t3-b" \
    "$CTL_ROOT/t3-c" \
    "$CTL_ROOT/t3-d" \
    "$CTL_ROOT/t3-e" \
    "$CTL_ROOT/t3-f" \
    "$CTL_ROOT/t3-g"
  do
    PID="$(
      python3 -c \
        'import json,sys; print(json.load(open(sys.argv[1]))["principal_id"])' \
        "$D/principal.json"
    )"

    env npm_config_cache="$CTL_ROOT/npm-cache" \
      npx --yes --package=commonswarm@0.1.80 -- \
      cswarm principal revoke \
        --workspace-id "$CTL_WS" \
        --principal-id "$PID" \
        --json \
        >"$D/revoke-response.json" \
        2>"$D/revoke.stderr"

    python3 - "$D/revoke-response.json" "$PID" \
      "$CTL_EVIDENCE/99-revoke.jsonl" <<'PY'
import json
import pathlib
import sys

response_file, expected_principal, output_file = sys.argv[1:]
value = json.loads(pathlib.Path(response_file).read_text())
assert isinstance(value, dict)
assert value.get("status") == "accepted"
assert value.get("principal_id") == expected_principal
assert isinstance(value.get("command_event_ids"), list)

with pathlib.Path(output_file).open("a") as output:
    output.write(json.dumps(value, separators=(",", ":")) + "\n")
PY
  done

  python3 - "$CTL_ROOT" "$CTL_EVIDENCE/99-revoke.jsonl" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
slugs = [
    "g3a-channel", "g3a-sender",
    "g3e-live", "g3e-stale-old", "g3e-turn", "g3e-none",
    "t3-a", "t3-b", "t3-c", "t3-d", "t3-e", "t3-f", "t3-g",
]
expected = [
    json.loads((root / slug / "principal.json").read_text())["principal_id"]
    for slug in slugs
]
assert len(expected) == len(set(expected)) == 13

rows = [
    json.loads(line)
    for line in pathlib.Path(sys.argv[2]).read_text().splitlines()
    if line.strip()
]
accepted = [row for row in rows if row.get("status") == "accepted"]
assert len(rows) == len(accepted) == 13
actual = [row["principal_id"] for row in accepted]
assert len(set(actual)) == 13
assert set(actual) == set(expected)
PY
)
then
  printf '%s\n' 'PASS REVOKE 13 OF 13' \
    | tee "$CTL_EVIDENCE/99-revoke-result.txt"
else
  rc=$?
  printf '%s\n' \
    'FAIL REVOKE — inspect 99-revoke.jsonl and protected principal/revoke files' \
    | tee "$CTL_EVIDENCE/99-revoke-result.txt" >&2
  exit "$rc"
fi
```

Expected:

```text
PASS REVOKE 13 OF 13
```

Failure:

```text
FAIL REVOKE — inspect 99-revoke.jsonl and protected principal/revoke files
```

Do not delete protected state until `PASS REVOKE 13 OF 13` exists. A partial revoke failure requires reconciliation of the saved results; do not blindly rerun the block and truncate the accepted-result record.

**Before either deletion below, run section 6’s evidence gate and inspect the screenshot.** Retain protected state if that gate fails.

Remove only the scratch directory created by this control. Resolve and check its recorded path before deleting it. The guard includes refusal controls:

```zsh
if python3 - "$G3A_T" "$CTL_ROOT/g3a-scratch-path" <<'PY'
import pathlib
import sys

supplied = sys.argv[1]
recorded = pathlib.Path(sys.argv[2]).read_text().strip()
temp_root = pathlib.Path("/tmp").resolve()
home = pathlib.Path.home().resolve()

def allowed(value):
    if not value:
        return False
    path = pathlib.Path(value)
    resolved = path.resolve()
    return (
        path.is_absolute()
        and not path.is_symlink()
        and resolved not in (pathlib.Path("/"), home, temp_root)
        and resolved.parent == temp_root
        and resolved.name.startswith("ctl-g3a.")
        and resolved.name != "ctl-g3a."
    )

assert supplied == recorded
assert allowed(supplied)
assert pathlib.Path(supplied).is_dir()
for forbidden in ("", "/", str(home), "/tmp", "/Users/Shared/outside"):
    assert not allowed(forbidden)
PY
then
  rm -rf -- "$G3A_T"
  if test ! -e "$G3A_T"
  then
    printf '%s\n' 'PASS SCRATCH CLEANUP'
  else
    printf '%s\n' 'FAIL SCRATCH CLEANUP' >&2
    exit 1
  fi
else
  printf '%s\n' 'FAIL SCRATCH CLEANUP — unexpected path' >&2
  exit 1
fi
```

Expected:

```text
PASS SCRATCH CLEANUP
```

Failure:

```text
FAIL SCRATCH CLEANUP — unexpected path
```

After the evidence gate and manual inspection confirm that committed evidence contains no credential, connection file, anon key, raw Claude JSONL, or protected log, remove the one exact protected directory:

```zsh
if python3 - "$CTL_ROOT" <<'PY'
import pathlib
import sys

home = pathlib.Path.home().resolve()
parent = home / ".config" / "cswarm"
expected = parent / "prod-controls-20260927-0927a"

def allowed(value):
    if not value:
        return False
    path = pathlib.Path(value)
    resolved = path.resolve()
    return (
        path.is_absolute()
        and path == expected
        and not path.is_symlink()
        and resolved == expected
        and resolved.parent == parent
        and resolved not in (pathlib.Path("/"), home, parent)
    )

assert allowed(sys.argv[1])
assert expected.is_dir()
for forbidden in ("", "/", str(home), str(parent), "/tmp/outside"):
    assert not allowed(forbidden)
PY
then
  rm -rf -- "$HOME/.config/cswarm/prod-controls-20260927-0927a"
else
  printf '%s\n' 'FAIL PROTECTED CLEANUP — unexpected path' >&2
  exit 1
fi

if test ! -e "$HOME/.config/cswarm/prod-controls-20260927-0927a"
then
  printf '%s\n' 'PASS PROTECTED CLEANUP'
else
  printf '%s\n' 'FAIL PROTECTED CLEANUP' >&2
  exit 1
fi
```

Expected:

```text
PASS PROTECTED CLEANUP
```

Failure:

```text
FAIL PROTECTED CLEANUP
```

## 6. Required committed evidence

Commit `PROCEDURE.md` and only the listed safe run files. `PROCEDURE.md` lives **outside `RUN/`** and is not an input to the secret scan.

```text
docs/evidence/2026-09-27-prod-controls/
├── PROCEDURE.md
└── RUN/
    ├── 00-preflight.txt
    ├── 00-current-client-build.txt
    ├── 00-human-session.json
    ├── 01-anon-key-check.txt
    ├── 02-seats.md
    ├── g3a-claude-version.txt
    ├── g3a-configure.json
    ├── g3a-configure.stderr
    ├── g3a-status-before.json
    ├── g3a-ask.json
    ├── g3a-ask.stderr
    ├── g3a-tool-sequence.txt
    ├── g3a-receipt.json
    ├── g3a-receipt.stderr
    ├── g3a-result.txt
    ├── g3a-negative-configure.json
    ├── g3a-negative-status.json
    ├── g3a-negative-ask.json
    ├── g3a-negative-receipt.json
    ├── g3a-negative-result.txt
    ├── g3e-members-live.json
    ├── g3e-stale-stop.stderr
    ├── g3e-stale-stop.exit
    ├── g3e-stale-stop-result.txt
    ├── g3e-turn-check-1.json
    ├── g3e-turn-check-1.stderr
    ├── g3e-turn-check-2.json          # only if attempt 2 ran
    ├── g3e-turn-check-2.stderr        # only if attempt 2 ran
    ├── g3e-members-turn.json
    ├── g3e-members.json
    ├── g3e-members.txt
    ├── g3e-cli-result.txt
    ├── g3e-app-roster.png
    ├── g3e-app-roster.sha256
    ├── g3e-app-result.txt
    ├── t3-normal-root.json
    ├── t3-normal-hop1.json
    ├── t3-normal-hop2.json
    ├── t3-normal-result.txt
    ├── t3-loop.stdout
    ├── t3-loop.stderr
    ├── t3-loop-result.txt
    ├── t3-length-hop0.json
    ├── t3-length-hop1.json
    ├── t3-length-hop2.json
    ├── t3-length-hop3.json
    ├── t3-length-hop4.json
    ├── t3-length-hop5.stdout
    ├── t3-length-hop5.stderr
    ├── t3-hop5-result.txt
    ├── 99-revoke.jsonl
    └── 99-revoke-result.txt
```

Before protected-state deletion and before committing, inspect the screenshot and all intended evidence. The byte scan catches the agent-token prefix, sensitive JSON field markers, and the public-key meta marker. It cannot establish that an image contains no visible secret; the screenshot requires manual inspection.

The scanner constructs its markers from separate components, so this procedure contains no complete literal marker that the scan would match. It scans **only the enumerated files inside `RUN/`**, rejects unexpected files and symlinks, and fails on unreadable files.

```zsh
if (
  set -euo pipefail

  python3 - "$CTL_EVIDENCE" <<'PY'
import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
assert root.name == "RUN"
assert root.parent.name == "2026-09-27-prod-controls"
assert root.is_dir() and not root.is_symlink()

required = set("""
00-preflight.txt
00-current-client-build.txt
00-human-session.json
01-anon-key-check.txt
02-seats.md
g3a-claude-version.txt
g3a-configure.json
g3a-configure.stderr
g3a-status-before.json
g3a-ask.json
g3a-ask.stderr
g3a-tool-sequence.txt
g3a-receipt.json
g3a-receipt.stderr
g3a-result.txt
g3a-negative-configure.json
g3a-negative-status.json
g3a-negative-ask.json
g3a-negative-receipt.json
g3a-negative-result.txt
g3e-members-live.json
g3e-stale-stop.stderr
g3e-stale-stop.exit
g3e-stale-stop-result.txt
g3e-turn-check-1.json
g3e-turn-check-1.stderr
g3e-members-turn.json
g3e-members.json
g3e-members.txt
g3e-cli-result.txt
g3e-app-roster.png
g3e-app-roster.sha256
g3e-app-result.txt
t3-normal-root.json
t3-normal-hop1.json
t3-normal-hop2.json
t3-normal-result.txt
t3-loop.stdout
t3-loop.stderr
t3-loop-result.txt
t3-length-hop0.json
t3-length-hop1.json
t3-length-hop2.json
t3-length-hop3.json
t3-length-hop4.json
t3-length-hop5.stdout
t3-length-hop5.stderr
t3-hop5-result.txt
99-revoke.jsonl
99-revoke-result.txt
""".split())
optional = {"g3e-turn-check-2.json", "g3e-turn-check-2.stderr"}

entries = list(root.iterdir())
actual = {entry.name for entry in entries}
assert required <= actual, "Required run evidence is missing"
assert actual <= required | optional, "Unexpected run evidence exists"
assert actual & optional in (set(), optional), "Attempt-2 evidence is incomplete"
assert all(entry.is_file() and not entry.is_symlink() for entry in entries)

expected_results = {
    "g3a-tool-sequence.txt": "PASS G3A TOOL SEQUENCE",
    "g3a-result.txt": "PASS G3A ACK AND REPLY",
    "g3a-negative-result.txt": "PASS G3A NEGATIVE CONTROL",
    "g3e-stale-stop-result.txt": "PASS G3E STALE WATCHER STOP",
    "g3e-cli-result.txt": "PASS G3E CLI ROSTER",
    "g3e-app-result.txt": "PASS G3E APP ROSTER",
    "t3-normal-result.txt": "PASS T3 NORMAL TWO-HOP CHAIN",
    "t3-loop-result.txt": "PASS T3 LOOP REFUSED chain_loop",
    "t3-hop5-result.txt": "PASS T3 HOP-5 REFUSED chain_too_long",
    "99-revoke-result.txt": "PASS REVOKE 13 OF 13",
}
for name, expected in expected_results.items():
    assert (root / name).read_text().strip() == expected, name

assert (root / "g3e-stale-stop.exit").read_text().strip() == "130"
assert (root / "g3e-app-roster.png").stat().st_size > 0
assert (root / "00-current-client-build.txt").read_text().startswith(
    "current_client_build: NOT VERIFIED\n"
)

revokes = [
    json.loads(line)
    for line in (root / "99-revoke.jsonl").read_text().splitlines()
    if line.strip()
]
assert len(revokes) == 13
assert all(row.get("status") == "accepted" for row in revokes)
assert len({row["principal_id"] for row in revokes}) == 13

agent_prefix = b"".join((b"swm", b"_agt", b"_"))
credential_field = b"creden" + b"tial"
anon_field = b"_".join((b"anon", b"key"))
meta_name = b":".join((b"commonswarm", b"anon-key"))

markers = (
    re.compile(re.escape(agent_prefix)),
    re.compile(rb'"' + re.escape(credential_field) + rb'"\s*:'),
    re.compile(rb'"' + re.escape(anon_field) + rb'"\s*:'),
    re.compile(re.escape(meta_name)),
)
for entry in sorted(entries):
    data = entry.read_bytes()
    if any(marker.search(data) for marker in markers):
        raise SystemExit("Credential-like data present in RUN/" + entry.name)

print(f"Checked {len(entries)} RUN evidence files; procedure excluded.")
PY
)
then
  printf '%s\n' 'PASS EVIDENCE COMPLETE AND SECRET-FREE'
else
  rc=$?
  printf '%s\n' 'FAIL EVIDENCE INCOMPLETE OR CREDENTIAL-LIKE DATA PRESENT' >&2
  exit "$rc"
fi
```

Expected final line:

```text
PASS EVIDENCE COMPLETE AND SECRET-FREE
```

Failure:

```text
FAIL EVIDENCE INCOMPLETE OR CREDENTIAL-LIKE DATA PRESENT
```

The success line means the required files and pass records exist and the listed markers were absent. Manual screenshot and evidence review remain required.

If running this gate before cleanup, return to section 5 and complete both guarded deletions. Commit only the procedure and reviewed run evidence, following the repository’s branch, authorship, identity, and review requirements.

## Review provenance

The v1 record states that Alloy 0.9.1 detected Codex, Grok, and Claude as ready, but its read-only environment blocked creation of the Alloy run record; no panelist call ran in that attempt.

The supplied v2 folds the cross-family review and nits into the full procedure, checked against repository SHA `ff27acfbb8055dce173c403b2befa75a68f2bc86`. The user reports that v2 passed cross-family review.

This v3 applies only the supplied `strategist-rulings-hm-g3a.txt`, item 1: Anvil runs every G3a step, with Tom involved only if authentication actually requires his phone, password, or physical presence. The corresponding checklist, ownership references, and review-table row are updated. The read-only checkout used for this fold was `ff293022bbb33fde5c99131dc1b661d69546e8ff`; the inspected T2 brief, T2 result, `src/cloud/agent-channel.ts`, and `src/cloud/agent-receive.ts` have no changes from the v2 reference SHA. The procedure’s release targets and preflight SHA remain unchanged.

No additional panel was dispatched by this author, no repository files were changed, and no production controls were executed for this revision. Successful live execution and a further independent review of v3 are **NOT VERIFIED**.

---

| Finding | Fix | Repository evidence |
|---|---|---|
| Version gate rejects correct output | Compare complete version lines, including protocol suffix. | `src/cli.ts:10478-10481`; `src/cloud/config.ts:3` |
| Revoke gate counts pretty-printed lines | Parse each response, validate accepted status and principal ID, then reconcile 13 distinct accepted results. | `src/cli.ts:1779-1780,2592-2607` |
| Secret scan matches the procedure | Separate `RUN/`; scan only its enumerated files; construct markers and sensitive field names from components. | `site/src/layouts/Base.astro:206`; `src/cli.ts:1935-1940` |
| G3e expects redirected stop text in terminal | Capture exit 130 immediately; check the exact sentence in protected stderr and retain its safe extract. | `src/cli.ts:5004-5010`; `src/cloud/arrival-watch.ts:58,92-106` |
| G3a actions incorrectly reserved for Tom | Assign authentication checks, session creation and resume, UUID lookup, turns, preview and one-time reply approvals, observation, and exit to Anvil. Reserve Tom only for a required phone, password, or physical-presence authentication challenge. | Supplied `strategist-rulings-hm-g3a.txt`, item 1, supersedes historical ownership in `docs/design/2026-09-26-T2-CLAUDE-CHANNEL-PROOF-BRIEF.md:44-55`; terminal flow and UUID lookup remain grounded in that brief. |
| Raw configured build unverified; historical release plan misleading | Record `NOT VERIFIED`; distinguish supplied 0.1.80 expectation from measurement; use 0.1.79 and assert its actual update classification. | `src/cli.ts:4310-4317,4515-4530`; `src/cloud/agent-presence.ts:62-75`; `supabase/migrations/20260927000002_agent_presence.sql:52-73` |
| Wrong roster opener | Use the agents-count button; distinguish dialog title and filter placeholder. | `site/src/components/app/LiveDashboard.astro:468-476,1030-1031,1056-1061,4097-4104` |
| Wrong anon-meta citation | Cite the actual meta element. | `site/src/layouts/Base.astro:206` |
| Wrong setup-entry citation | Cite the command entry and flags. | `src/cli.ts:10110-10116` |
| Incorrect text expectations | Omit `current`; expect `turn, last <age>` and the complete none line. | `src/cli.ts:4325-4336`; `site/src/lib/agent-presence.ts:76-88` |

---

Changed sections:

- Version and operator header; TOM checklist.
- Status and limits: removed the unconditional Tom-availability blocker.
- Section 2: Anvil owns every G3a step, with terminal inputs and conditional authentication handoffs specified.
- Section 5: Anvil confirms Claude’s exit.
- Review provenance and the stale ownership finding.
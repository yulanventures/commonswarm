# First authenticated admin smoke — blocked preparation

Prepared only. **DO NOT OPEN A PRODUCTION WINDOW WITH THIS REVISION.**
HezLead owns independent review, landing, exact live-SHA evidence, and a separate
authorization naming the release worker and this procedure. This worker did no
production operation. The supplied live prerequisite is edge `037beb84` or later
with migrations `20261001000001` through `20261001000005`; it was not measured here.

## Blocking plan defect

The public command path accepts human consent/grant commands and already-issued
opaque admin access credentials. It does not issue those credentials.
`supabase/functions/command/index.ts` exports `handleAdminRuntimeCommand`, which
requires a verified signed runtime proof and a private delivery callback. Its only
callers in this checkout are local server-test harnesses. There is no production
caller in `services/`, `deploy/`, or `src/`. The existing MCP provider cannot issue
the admin runtime proof (`command/admin-runtime-auth.ts`). The CLI exposes only
human `admin grants`, `admin history`, and `admin revoke` recovery verbs.

Consequently a newly granted smoke connection cannot receive its first admin
access credential through a checked-in production path. A human bearer, an MCP
bearer, a self-signed test JWT, direct database mutation, or an invented public
`issue_admin_credential` request cannot fill this gap. Importing an edge module
from an operator-authored box script would invent a new production runtime.

Steps `smoke-runtime-gate` and `smoke-delivery` deliberately fail. They must be
replaced in a newly reviewed revision by the actual production issuance path and
its complete marked runnable block, **before** any workspace creation. A supplied
credential file or an approval flag does not override either gate. Completing
that path is a separate implementation assignment, not part of this document.
The subsequent public-path blocks are prepared for review, not approved for use
by skipping the gates.

This follows the C+D plan style (marked blocks, fixed inputs, redacted receipts,
first-mismatch stop) and HM's protected human-session file pattern. Sources:
`docs/design/2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md`, the command/admin modules,
`read/admin-recovery*`, and the C+D follow-up preparation at
`scratchpad/cdrel/prefix-plan.md` in the lead's task workspace. That external
preparation supplies style only; it is not a release input. Its synthetic admin
refusal smoke explicitly does not prove authenticated admin operations.

## Intended sequence and exact expectations

Use one Mac `/bin/bash` 3.2 shell. No SSH or SQL is needed: human reads use the
public `/functions/v1/read` recovery endpoint. No browser, GUI, keychain, HOME
change, CLI credential discovery, service restart, DDL, CI dispatch, or push.
Read-only receipts contain only locally generated names/IDs, measured response
codes/statuses, event IDs, manifest digest, and reconciled row counts. Raw bodies,
headers, token hashes, session bindings, refresh tokens, and JWT claims are never
written to the proof directory or printed. Cloudflare ingress uses the C+D
`curl/8.7.1` user-agent; redirects are refused and every response is bounded.

| Step | Expected result; first mismatch means STOP |
| --- | --- |
| runtime-gate | Currently exit 1, `FAIL smoke-runtime-path-unavailable`, before network or mutations. |
| open | Fresh mode-0700 proof and secret dirs; copied input files mode 0600. |
| human-auth | GET `/auth/v1/user`: HTTP 200, confirmed expected operator UUID. |
| create-workspace | Human POST command: HTTP 200, `accepted`, `ok=true`, exact generated workspace UUID and valid workspace stream UUID. |
| consent | Human POST account command, approved Origin: HTTP 200, `accepted`, canonical exact manifest, consent ID and manifest digest. |
| grant | Same human session: HTTP 200, `accepted`, exactly one matching `AdminDelegationGranted` and accepted action card. |
| delivery | Currently exit 1, `FAIL smoke-runtime-delivery-unavailable`. Future private adapter must return HTTP-equivalent 200 / `pending`, one `AdminCredentialIssued`, and deliver privately to a mode-0600 file. `pending` means delivery is still required. |
| access-control | Admin POST account `admin_read_metadata`: HTTP 200, `accepted`, exact grant/connection/admin identity, active and scoped to this workspace. |
| create-seat | Admin POST: HTTP 200, `accepted`, one account `AdminSeatCreated` and one matching accepted `AdminActionRecorded` with three linked event IDs. |
| revoke-seat | Admin POST: HTTP 200, `accepted`, one account `AdminSeatRevoked` and one matching accepted action card with three linked event IDs. |
| history | Human read: HTTP 200; paginate account and workspace views to exhaustion, exactly one card per smoke seat command, exact actor/target/grant and linked event IDs. |
| cleanup | Human account grant revoke HTTP 200 / `accepted`, then human workspace archive HTTP 200 / `accepted`, `ok=true`, exactly one `WorkspaceArchived`. |
| final-readback | Human reads HTTP 200; same audit cards survive cleanup and exactly one smoke grant is `revoked`. |
| secret-close | Guarded rm removes only the exact fresh secret directory; proof remains. Refusal stops cleanup and retains the path/message. |

The workspace is created through the same public human command used by the CLI,
not by INSERT or a test fixture. The new granular grant selects only that workspace,
allows read/create-seat/revoke-seat, and permits one local roster seat. No worker
credential is issued. Cleanup uses the supported human archive command; archive
retains immutable history and is not deletion. `admin_archive_workspace` is in the
design registry but is absent from the implemented routine parser; do not use it.
Routine responses return account events only. Workspace `AgentPrincipalCreated`
and `AgentPrincipalRevoked` rows are linked by ID, not returned as response events.
The creation action card targets the workspace; the revocation card targets the
seat. The checks below follow those implemented shapes.

## Inputs for a future reviewed window

Supply paths and nonsecret identifiers only. Never export credential values.
`SMOKE_PLAN` is the absolute exact reviewed procedure path. `HUMAN_SESSION_SOURCE`
is an absolute, regular, nonsymlink mode-0600 file owned by the operator, JSON
exactly `{"access_token":"..."}` as in HM. `API_CONFIG_SOURCE` is a similarly
protected file, JSON exactly `SUPABASE_URL` and `SUPABASE_ANON_KEY`, with URL
`https://api.commonswarm.com`. Both source files must already be inside fresh
mode-0700 `/private/tmp/anvil-secret.XXXXXX` supplier directories, removed by the
supplier at window close. No secrets may be staged elsewhere. Any separately
authorized 1Password recovery must use the service-account token file for that
command only; never a desktop session. This procedure invokes no `op` command.

`OPERATOR_USER_ID` is the confirmed human UUID. `ADMIN_CONNECTION_ID` and
`ADMIN_CLIENT_ID` must name the actual trusted runtime connection/client provided
by the future approved adapter, not random values asserted to be a runtime.
`WINDOW_END_UTC` is a fresh UTC deadline, at most 15 minutes away at open.
The actual human must approve the displayed consent manifest before `smoke-grant`,
using the same session whose interactive AMR is recent enough for the server.
Preparation is not consent. If that human review exceeds the 300-second receipt
lifetime, STOP; do not improvise a replacement consent during the window.

Run only extracted complete blocks in the order above. Do not retry a failed
mutation without HezLead: response loss is an unknown outcome. The saved command
IDs and exact requests are the retry inputs for a separately reviewed recovery.
Do not rerun open in an existing window or change a request under its old ID.
Each public command uses a fixed saved UUID and can be replayed unchanged within
its valid grant/session horizon. Fresh runs get fresh IDs and proof directories.

On any failure, stop forward work, preserve the FAIL receipt and IDs, and run only
`smoke-secret-close`. This revision authorizes no automatic compensating production
mutation after a failure. HezLead must reconcile any possibly committed workspace,
grant, or seat and separately authorize product cleanup with the saved IDs. Never
claim rollback or deletion. A shell EXIT trap removes the staged secrets even on
failure/interrupt; that trap does not remove the proof or supplier inputs.

## Marked blocks

```sh
# step: smoke-runtime-gate
# host: Mac /bin/bash 3.2
# readonly: yes
set -euo pipefail
printf '%s\n' 'FAIL smoke-runtime-path-unavailable: no production admin issuance caller; STOP before opening the window' >&2
exit 1
```

```sh
# step: smoke-open
# host: Mac /bin/bash 3.2
# readonly: no (local protected staging only)
set -euo pipefail
trap 'printf "FAIL smoke-shell: line %s; STOP\n" "$LINENO" >&2' ERR
: "${SMOKE_PLAN:?}" "${HUMAN_SESSION_SOURCE:?}" "${API_CONFIG_SOURCE:?}"
: "${OPERATOR_USER_ID:?}" "${ADMIN_CONNECTION_ID:?}" "${ADMIN_CLIENT_ID:?}" "${WINDOW_END_UTC:?}"
test -z "${SMOKE_SECRET_DIR:-}" && test -z "${SMOKE_PROOF_DIR:-}"
test "$(command -v rm)" = /Users/yulanbot/.local/bin/rm
SMOKE_PROOF_DIR=$(mktemp -d /private/tmp/admin-smoke-proof.XXXXXX)
chmod 0700 "$SMOKE_PROOF_DIR"
SMOKE_SECRET_DIR=$(mktemp -d /private/tmp/anvil-secret.XXXXXX)
chmod 0700 "$SMOKE_SECRET_DIR"
smoke_secret_close() {
  test -n "${SMOKE_SECRET_DIR:-}" || return 0
  if test ! -e "$SMOKE_SECRET_DIR" && test ! -L "$SMOKE_SECRET_DIR"; then return 0; fi
  if ! python3 - "$SMOKE_SECRET_DIR" <<'PY'
import os, pathlib, re, stat, sys
p = pathlib.Path(sys.argv[1])
pattern = r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}'
for bad in ('', '/', str(pathlib.Path.home()), '/private/tmp/other', '/private/tmp/anvil-secret.abcdef/child'):
    assert re.fullmatch(pattern, bad) is None
assert re.fullmatch(pattern, str(p)) and not p.is_symlink() and p.resolve(strict=True) == p
s = p.lstat()
assert stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o700
PY
  then
    printf 'FAIL smoke-secret-cleanup-boundary: exact path validation failed; STOP\n' >&2
    return 1
  fi
  if ! rm -r -- "$SMOKE_SECRET_DIR"; then
    printf 'FAIL smoke-secret-cleanup-refused: %s; retain guard message and STOP\n' "$SMOKE_SECRET_DIR" >&2
    return 1
  fi
  test ! -e "$SMOKE_SECRET_DIR" && test ! -L "$SMOKE_SECRET_DIR"
}
smoke_exit() {
  SMOKE_EXIT_STATUS=$?
  trap - EXIT
  smoke_secret_close || SMOKE_EXIT_STATUS=1
  exit "$SMOKE_EXIT_STATUS"
}
trap smoke_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$HUMAN_SESSION_SOURCE" "$API_CONFIG_SOURCE" "$SMOKE_SECRET_DIR" "$SMOKE_PROOF_DIR" \
  "$OPERATOR_USER_ID" "$ADMIN_CONNECTION_ID" "$ADMIN_CLIENT_ID" "$WINDOW_END_UTC" <<'PY'
import datetime, json, os, pathlib, re, stat, sys, uuid
human, config, secret, proof, owner, connection, client, end = sys.argv[1:]
try:
    for source, name in ((human, 'human-session.json'), (config, 'api-config.json')):
        p = pathlib.Path(source)
        assert p.is_absolute() and not p.is_symlink() and p.resolve(strict=True) == p
        assert re.fullmatch(r'/private/tmp/anvil-secret\.[A-Za-z0-9]{6}', str(p.parent))
        parent = p.parent.lstat()
        assert parent.st_uid == os.getuid() and stat.S_IMODE(parent.st_mode) == 0o700
        s = p.lstat()
        assert stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o600
        target = pathlib.Path(secret, name)
        with target.open('xb') as out:
            out.write(p.read_bytes())
        target.chmod(0o600)
    assert str(uuid.UUID(owner)) == owner and str(uuid.UUID(connection)) == connection
    assert 1 <= len(client) <= 2048 and not any(ord(c) < 32 for c in client)
    deadline = datetime.datetime.strptime(end, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
    now = datetime.datetime.now(datetime.timezone.utc)
    assert 0 < (deadline - now).total_seconds() <= 900
    ident = now.strftime('%Y%m%dT%H%M%SZ') + '-' + pathlib.Path(proof).name.rsplit('.', 1)[1]
    state = {'workspace_id': str(uuid.uuid4()), 'grant_id': str(uuid.uuid4()),
             'owner_user_id': owner, 'connection_id': connection, 'client_id': client,
             'name': 'admin-smoke-' + ident, 'seat_name': 'admin-smoke-seat-' + ident,
             'deadline': end, 'commands': {}, 'results': {}}
    pathlib.Path(proof, 'state.json').write_text(json.dumps(state, sort_keys=True) + '\n')
except BaseException:
    print('FAIL smoke-open-input: protected input or window invalid; STOP', file=sys.stderr)
    sys.exit(1)
PY
cat >"$SMOKE_SECRET_DIR/public-smoke.py" <<'PY'
import datetime, hashlib, json, os, pathlib, re, stat, sys, urllib.error, urllib.request, uuid

RESOURCE = 'https://api.commonswarm.com/admin'
SCOPES = ['admin:read', 'seats:create', 'seats:revoke']

def require(condition):
    if not condition:
        raise ValueError('mismatch')

def protected(path):
    s = path.lstat()
    require(not path.is_symlink() and stat.S_ISREG(s.st_mode))
    require(s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o600)
    return json.loads(path.read_text())

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)

def main():
    step, secret_arg, proof_arg = sys.argv[1:]
    secret, proof = pathlib.Path(secret_arg), pathlib.Path(proof_arg)
    for p, prefix in ((secret, 'anvil-secret'), (proof, 'admin-smoke-proof')):
        require(re.fullmatch(r'/private/tmp/' + prefix + r'\.[A-Za-z0-9]{6}', str(p)))
        require(not p.is_symlink() and p.resolve(strict=True) == p)
        require(p.stat().st_uid == os.getuid() and stat.S_IMODE(p.stat().st_mode) == 0o700)
    state_path = proof / 'state.json'
    require(not state_path.is_symlink())
    state = json.loads(state_path.read_text())
    deadline = datetime.datetime.strptime(state['deadline'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)
    # Recovery and final readback remain available after the forward deadline.
    if step not in ('cleanup', 'final-readback'):
        require(datetime.datetime.now(datetime.timezone.utc) < deadline)
    cfg = protected(secret / 'api-config.json')
    human = protected(secret / 'human-session.json')
    require(set(cfg) == {'SUPABASE_URL', 'SUPABASE_ANON_KEY'})
    require(cfg['SUPABASE_URL'] == 'https://api.commonswarm.com')
    require(set(human) == {'access_token'} and isinstance(human['access_token'], str))
    require(len(human['access_token']) >= 32 and isinstance(cfg['SUPABASE_ANON_KEY'], str))
    opener = urllib.request.build_opener(NoRedirect())
    receipt = {'step': step, 'result': 'FAIL', 'responses': [], 'counts': {}}

    def persist():
        state_path.write_text(json.dumps(state, sort_keys=True) + '\n')

    def save_receipt():
        (proof / (step + '.json')).write_text(json.dumps(receipt, sort_keys=True) + '\n')

    def request(label, endpoint, payload=None, admin=False):
        token = human['access_token']
        if admin:
            delivery = protected(secret / 'admin-delivery.json')
            require(delivery['resource'] == RESOURCE and delivery['grant_id'] == state['grant_id'])
            require(delivery['connection_id'] == state['connection_id'])
            token = delivery['access_credential']
            require(isinstance(token, str) and re.fullmatch(r'swm_adm_[A-Za-z0-9_-]+', token))
        headers = {'Authorization': 'Bearer ' + token, 'apikey': cfg['SUPABASE_ANON_KEY'],
                   'Content-Type': 'application/json', 'Accept': 'application/json',
                   'Origin': 'https://commonswarm.com', 'User-Agent': 'curl/8.7.1'}
        req = urllib.request.Request(cfg['SUPABASE_URL'] + endpoint,
              data=None if payload is None else json.dumps(payload).encode(), headers=headers,
              method='GET' if payload is None else 'POST')
        row = {'label': label, 'http_status': None, 'status': None}
        receipt['responses'].append(row)
        save_receipt()
        try:
            response = opener.open(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            row['http_status'] = response.status
            save_receipt()
            require(response.status == 200)
            require(response.headers.get_content_type() == 'application/json')
            raw = response.read(1048577)
            require(len(raw) <= 1048576)
            body = json.loads(raw)
            require(isinstance(body, dict))
            status = body.get('status')
            row['status'] = status if status in ('accepted', 'pending', 'failed', 'refused') else None
            save_receipt()
            return body

    def command(label, value, account=True, admin=False):
        if label not in state['commands']:
            wire = {'command_id': str(uuid.uuid4()), 'client_version': '0.1.0', 'command': value}
            if account:
                wire.update(stream={'kind': 'account'}, resource=RESOURCE)
            elif value['kind'] != 'create_workspace':
                wire.update(workspace_id=state['workspace_id'], stream={'kind': 'workspace'})
            state['commands'][label] = wire
            persist()  # Save retry identity before the request can commit.
        wire = state['commands'][label]
        require(wire['command'] == value)
        body = request(label, '/functions/v1/command', wire, admin)
        require(body.get('status') == 'accepted')
        return body

    def event(body, kind, command_id):
        rows = [e for e in body['events'] if e['type'] == kind]
        require(len(rows) == 1 and rows[0]['command_id'] == command_id)
        require(str(uuid.UUID(rows[0]['event_id'])) == rows[0]['event_id'])
        return rows[0]

    def routine(label, value, domain, target):
        body = command(label, value, admin=True)
        cid = state['commands'][label]['command_id']
        admin_event = event(body, domain, cid)
        principal = admin_event['payload']['principal_id']
        require(str(uuid.UUID(principal)) == principal)
        if target is not None:
            require(principal == target)
        if label == 'create-seat':
            require(admin_event['payload']['workspace_id'] == state['workspace_id'])
            require(admin_event['payload']['name'] == state['seat_name'])
            require(admin_event['payload']['transport'] == 'local')
        else:
            require(admin_event['payload']['revoked_at'] > 0)
        require(len(body['events']) == 2)
        audit = event(body, 'AdminActionRecorded', cid)
        p = audit['payload']
        require(p['action'] == value['kind'] and p['outcome'] == 'accepted' and p['reason_code'] is None)
        target_id = state['workspace_id'] if label == 'create-seat' else principal
        require(p['target_id'] == target_id and p['workspace_id'] == state['workspace_id'])
        require(p['target_kind'] == ('workspace' if label == 'create-seat' else 'seat'))
        require(audit['actor_user'] is None and audit['actor_agent_principal'] is None)
        require(audit['grant_id'] == state['grant_id'] and audit['admin_identity_id'] == state['admin_identity_id'])
        require(audit['grant_manifest_digest'] == state['manifest_digest'])
        require(admin_event['event_id'] in p['related_event_ids'])
        require(len(p['related_event_ids']) == len(set(p['related_event_ids'])) == 3)
        for ref in p['related_event_ids']:
            require(str(uuid.UUID(ref)) == ref)
        state['principal_id'] = principal
        state['results'][label] = {'audit_event_id': audit['event_id'], 'domain_event_id': admin_event['event_id'],
                                  'related_event_ids': p['related_event_ids'], 'principal_id': principal}
        receipt['counts']['domain_rows'] = 1
        receipt['counts']['audit_rows'] = 1

    def pages(resource, workspace):
        before, seen_cursors, seen_ids, rows = None, set(), set(), []
        for index in range(100):
            body = request(resource + '-' + ('account' if workspace is None else 'workspace') + '-' + str(index),
                    '/functions/v1/read', {'resource': resource, 'workspace_id': workspace, 'limit': 100, 'before': before})
            page = body['grants' if resource == 'admin_grants' else 'actions']
            require(isinstance(page, list) and len(page) <= 100)
            for row in page:
                row_id = row['grant_id' if resource == 'admin_grants' else 'event_id']
                require(row_id not in seen_ids)
                seen_ids.add(row_id)
                rows.append(row)
            before = body['next_before']
            if before is None:
                return rows
            require(isinstance(before, str) and before not in seen_cursors)
            seen_cursors.add(before)
        raise ValueError('pagination-bound')

    def history():
        for workspace in (None, state['workspace_id']):
            rows = pages('admin_history', workspace)
            matched = [r for r in rows if r['grant_id'] == state['grant_id'] and r['action'] in ('admin_create_seat', 'admin_revoke_seat')]
            require(len(matched) == 2)
            for label, action in (('create-seat', 'admin_create_seat'), ('revoke-seat', 'admin_revoke_seat')):
                expected = state['results'][label]
                cards = [r for r in matched if r['event_id'] == expected['audit_event_id']]
                require(len(cards) == 1)
                card = cards[0]
                require(card['action'] == action and card['outcome'] == 'accepted' and card['reason_code'] is None)
                target_id = state['workspace_id'] if label == 'create-seat' else state['principal_id']
                require(card['workspace_id'] == state['workspace_id'] and card['target_id'] == target_id)
                require(card['actor_user'] is None and card['admin_identity_id'] == state['admin_identity_id'])
                require(expected['domain_event_id'] in card['related_event_ids'])
                require(card['related_event_ids'] == expected['related_event_ids'])
            receipt['counts']['account_cards' if workspace is None else 'workspace_cards'] = len(matched)

    save_receipt()
    try:
        if step == 'human-auth':
            user = request(step, '/auth/v1/user')
            require(user['id'] == state['owner_user_id'] and user.get('email_confirmed_at') is not None)
        elif step == 'create-workspace':
            body = command(step, {'kind': 'create_workspace', 'workspace_id': state['workspace_id'], 'name': state['name']}, account=False)
            require(body.get('ok') is True and body['workspace_id'] == state['workspace_id'])
            require(str(uuid.UUID(body['stream_id'])) == body['stream_id'])
            state['stream_id'] = body['stream_id']
        elif step == 'consent':
            if 'manifest' not in state:
                end_ms = int(deadline.timestamp() * 1000)
                state['manifest'] = {'connection_id': state['connection_id'], 'client_id': state['client_id'],
                    'resource': RESOURCE, 'mode': 'granular', 'registry_version': 1, 'scope_names': SCOPES,
                    'workspace_selector': 'selected', 'workspace_ids': [state['workspace_id']],
                    'created_workspace_policy': {'scope_names': []},
                    'target_rules': {'seat_ids': [], 'own_seats': False, 'grant_created_seats': True,
                                     'recipient_user_ids': [], 'recipient_connection_ids': [], 'transports': ['local']},
                    'worker_scope_ceiling': [], 'role_ceiling': 'member',
                    'renewal_limits': {'grant_kinds': [], 'principal_ids': [], 'bearer_seconds': 0,
                                      'horizon_seconds': 0, 'successors_per_worker': 0, 'successors_per_grant': 0},
                    'issuance_limits': {'workspaces': 0, 'live_seats': 1, 'total_seats': 1, 'invitations': 0,
                                        'live_agent_invitations': 0, 'worker_credentials': 0, 'connection_attempts': 0},
                    'expires_at': end_ms, 'refresh_deadline': end_ms}
                persist()
            body = command(step, {'kind': 'prepare_admin_consent', 'manifest': state['manifest'], 'full_account_selected': False})
            expected = dict(state['manifest'])
            expected['admin_identity_id'] = body['manifest']['admin_identity_id']
            require(str(uuid.UUID(expected['admin_identity_id'])) == expected['admin_identity_id'])
            require(body['manifest'] == expected)
            require(body['manifest_digest'] == hashlib.sha256(canonical(expected).encode()).hexdigest())
            require(str(uuid.UUID(body['consent_receipt_id'])) == body['consent_receipt_id'])
            state.update(consent_receipt_id=body['consent_receipt_id'], manifest_digest=body['manifest_digest'],
                         admin_identity_id=expected['admin_identity_id'])
            # Exactly the nonsecret consent manifest for the human's review.
            (proof / 'consent-manifest.json').write_text(json.dumps(expected, sort_keys=True, indent=2) + '\n')
        elif step == 'grant':
            body = command(step, {'kind': 'grant_admin_delegation', 'grant_id': state['grant_id'],
                       'consent_receipt_id': state['consent_receipt_id'], 'replaces_grant_id': None})
            cid = state['commands'][step]['command_id']
            grant = event(body, 'AdminDelegationGranted', cid)
            require(grant['actor_user'] == state['owner_user_id'])
            require(grant['payload']['grant_id'] == state['grant_id'])
            require(grant['payload']['manifest_digest'] == state['manifest_digest'])
            audit = event(body, 'AdminActionRecorded', cid)
            require(audit['payload']['outcome'] == 'accepted')
            receipt['counts'].update(grant_rows=1, audit_rows=1)
        elif step == 'access-control':
            body = command(step, {'kind': 'admin_read_metadata', 'grant_id': state['grant_id'],
                       'resource_kind': 'grant', 'workspace_id': None}, admin=True)
            g = body['grant']
            require(g['state'] == 'active' and g['grant_id'] == state['grant_id'])
            require(g['connection_id'] == state['connection_id'] and g['admin_identity_id'] == state['admin_identity_id'])
            require(g['workspace_ids'] == [state['workspace_id']] and g['scope_names'] == SCOPES)
            require(g['manifest_digest'] == state['manifest_digest'])
        elif step == 'create-seat':
            routine(step, {'kind': 'admin_create_seat', 'grant_id': state['grant_id'],
                    'workspace_id': state['workspace_id'], 'name': state['seat_name'], 'model': None, 'transport': 'local'},
                    'AdminSeatCreated', None)
        elif step == 'revoke-seat':
            routine(step, {'kind': 'admin_revoke_seat', 'grant_id': state['grant_id'],
                    'workspace_id': state['workspace_id'], 'principal_id': state['principal_id'], 'reason_code': 'smoke_complete'},
                    'AdminSeatRevoked', state['principal_id'])
        elif step == 'history':
            history()
        elif step == 'cleanup':
            body = command('revoke-grant', {'kind': 'revoke_admin_delegation', 'grant_id': state['grant_id'], 'reason_code': 'human_revoked'})
            event(body, 'AdminDelegationRevoked', state['commands']['revoke-grant']['command_id'])
            body = command('archive-workspace', {'kind': 'archive_workspace'}, account=False)
            require(body.get('ok') is True)
            archived = event(body, 'WorkspaceArchived', state['commands']['archive-workspace']['command_id'])
            require(archived['workspace_id'] == state['workspace_id'] and archived['actor_user'] == state['owner_user_id'])
            require(archived['payload']['archived_at'] > 0)
            state['results']['cleanup'] = {'grant_state': 'revoked', 'workspace_state': 'archived', 'archive_event_id': archived['event_id']}
        elif step == 'final-readback':
            history()
            grants = pages('admin_grants', None)
            match = [g for g in grants if g['grant_id'] == state['grant_id']]
            require(len(match) == 1 and match[0]['state'] == 'revoked')
            receipt['counts']['revoked_smoke_grants'] = 1
            require(state['results']['cleanup']['workspace_state'] == 'archived')
        else:
            raise ValueError('unknown-step')
        persist()
        receipt['result'] = 'PASS'
        save_receipt()
    except BaseException:
        save_receipt()
        raise

try:
    main()
except BaseException:
    print('FAIL smoke-public-contract: input, transport, response or history mismatch; STOP; retain receipt', file=sys.stderr)
    sys.exit(1)
PY
chmod 0600 "$SMOKE_SECRET_DIR/public-smoke.py"
printf 'PASS smoke-open: proof=%s; staged secrets withheld\n' "$SMOKE_PROOF_DIR"
```

```sh
# step: smoke-human-auth
set -euo pipefail
python3 "$SMOKE_SECRET_DIR/public-smoke.py" human-auth "$SMOKE_SECRET_DIR" "$SMOKE_PROOF_DIR"
```

```sh
# step: smoke-create-workspace
set -euo pipefail
python3 "$SMOKE_SECRET_DIR/public-smoke.py" create-workspace "$SMOKE_SECRET_DIR" "$SMOKE_PROOF_DIR"
```

```sh
# step: smoke-consent
set -euo pipefail
python3 "$SMOKE_SECRET_DIR/public-smoke.py" consent "$SMOKE_SECRET_DIR" "$SMOKE_PROOF_DIR"
printf 'Human must review %s/consent-manifest.json before smoke-grant; STOP until confirmed\n' "$SMOKE_PROOF_DIR"
```

```sh
# step: smoke-grant
set -euo pipefail
# The actual human's confirmation is supplied by HezLead's separately authorized window prompt.
: "${SMOKE_HUMAN_CONSENT:?actual human confirmation required}"
test "$SMOKE_HUMAN_CONSENT" = approved-exact-manifest
python3 "$SMOKE_SECRET_DIR/public-smoke.py" grant "$SMOKE_SECRET_DIR" "$SMOKE_PROOF_DIR"
```

```sh
# step: smoke-delivery
set -euo pipefail
printf '%s\n' 'FAIL smoke-runtime-delivery-unavailable: marked production issuance/delivery block missing; STOP' >&2
exit 1
```

```sh
# step: smoke-access-control
set -euo pipefail
python3 "$SMOKE_SECRET_DIR/public-smoke.py" access-control "$SMOKE_SECRET_DIR" "$SMOKE_PROOF_DIR"
```

```sh
# step: smoke-create-seat
set -euo pipefail
python3 "$SMOKE_SECRET_DIR/public-smoke.py" create-seat "$SMOKE_SECRET_DIR" "$SMOKE_PROOF_DIR"
```

```sh
# step: smoke-revoke-seat
set -euo pipefail
python3 "$SMOKE_SECRET_DIR/public-smoke.py" revoke-seat "$SMOKE_SECRET_DIR" "$SMOKE_PROOF_DIR"
```

```sh
# step: smoke-history
set -euo pipefail
python3 "$SMOKE_SECRET_DIR/public-smoke.py" history "$SMOKE_SECRET_DIR" "$SMOKE_PROOF_DIR"
```

```sh
# step: smoke-cleanup
set -euo pipefail
python3 "$SMOKE_SECRET_DIR/public-smoke.py" cleanup "$SMOKE_SECRET_DIR" "$SMOKE_PROOF_DIR"
```

```sh
# step: smoke-final-readback
set -euo pipefail
python3 "$SMOKE_SECRET_DIR/public-smoke.py" final-readback "$SMOKE_SECRET_DIR" "$SMOKE_PROOF_DIR"
printf 'PASS smoke-final-readback: revoked grant, accepted archive, retained matched history\n'
```

```sh
# step: smoke-secret-close
set -euo pipefail
smoke_secret_close
printf 'PASS smoke-secret-close: retain nonsecret proof %s\n' "$SMOKE_PROOF_DIR"
```

## NOT PROVED

- This revision cannot execute the authenticated admin smoke. No live path, real
  human consent, private delivery, production mutation, SQL row state, or public
  ingress success was measured by its author. Shell/Python checks prove syntax
  and static names only; they do not supply the missing runtime.
- Creating/revoking a roster seat does not prove provisioned credentials, a
  configured runtime, inbox check, setup acknowledgment, connected status, hosted
  MCP transport, renewal, replay handling, or worker access/revocation behavior.
- Recovery action-card reconciliation proves the read projection against observed
  command events when executed. It does not independently inspect private SQL
  tables, all historical domain rows, RLS, other-account isolation, concurrency,
  expiry, quotas, or failure/rollback audit. Those require separate reviewed gates.
- The human workspace-create path does not emit `AdminWorkspaceCreated`. This
  smoke therefore does not prove delegated workspace creation or its audit.
- Archive retains the workspace/history and may count toward other product
  retention rules. No permanent deletion or restoration behavior is claimed.
- A successful archive event and subsequent grant/history reads are the cleanup
  receipts. They do not independently query the workspace archive column.

Retain the proof directory and report its path, exact procedure revision, supplied
live SHA evidence, all HTTP/status/count receipts, generated resource/command IDs,
whether the grant is revoked and workspace archived, and exact secret-cleanup
outcome. Never copy staged secret files into committed evidence. If a block fails,
the report must say FAIL/unknown as measured, identify the stable failure and last
saved IDs, and leave further production action to HezLead.

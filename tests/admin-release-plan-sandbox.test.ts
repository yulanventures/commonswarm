/**
 * Release contract control `release-plan-contract / gui-denied-sandbox-dry-run`
 * (GATES.json; admin issuance spec row 8).
 *
 * Every marked RELEASE.md block whose `# host:` line names the Mac is executed in a
 * dry-run harness under /usr/bin/sandbox-exec. The profile denies process-exec of
 * /Applications/** and ~/Applications/** (and any Chrome/Chromium binary), reads of the
 * Chrome profile and ~/Library/Keychains, all network, and every file write outside this
 * test's own temporary root. External commands are PATH-first stubs that record argv;
 * unmodelled calls are refused (fail closed). A deliberately injected
 * `open -a "Google Chrome"` block is the positive control: the kernel must deny it.
 *
 * Safety: no real ~/work path, no real /private/tmp path, no HOME change, no secret,
 * no docker, no browser. The `open` stub execs an application binary only after it
 * has proved that the sandbox is active (the keychain read is refused).
 * The test must start outside any other sandbox-exec wrapper: macOS refuses a nested
 * profile (exit 71), and the test then fails rather than run anything uncontained.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';

const skip = process.platform !== 'darwin'
  ? 'sandbox-exec, its kernel denial log and the Mac host blocks exist only on macOS (process.platform !== "darwin")'
  : false;

const repo = resolve('.');
const directory = resolve('docs/evidence/2026-10-03-admin-issuance-release');
const planPath = join(directory, 'RELEASE.md');
const sitePlanPath = resolve('docs/evidence/2026-10-02-site-release/SITE-RELEASE.md');
const specPath = resolve('docs/design/2026-10-02-ADMIN-ISSUANCE-SPEC.md');
const plan = readFileSync(planPath, 'utf8');
// Same extraction convention as tests/admin-release-plan.test.ts: anchored closing fence.
const blocks = [...plan.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!);
const stepOf = (source: string) => /^# step: (ai-[a-z0-9-]+)$/.exec(source.split('\n')[0]!)?.[1];
const hostOf = (source: string) => /^# host: (.+)$/.exec(source.split('\n')[2]!)?.[1];
const macBlocks = blocks.filter(source => /\bMac\b/.test(hostOf(source) ?? ''));
const EXPECTED_MAC_STEPS = [
  'ai-inputs', 'ai-prepare', 'ai-extract', 'ai-edge-receipt', 'ai-gates', 'ai-ordinary-probes', 'ai-live-controls', 'ai-w2-stage-probes', 'ai-w3-probes', 'ai-w4-probes',
  'ai-w5-preflight', 'ai-w5-reference', 'ai-w5-closed', 'ai-w6-readiness', 'ai-w6-readiness-transfer',
  'ai-w6-activation-approval', 'ai-w6-activation-probes', 'ai-w6-c1-inputs', 'ai-w6-preflight', 'ai-w6-prepare', 'ai-w6-transfer',
  'ai-w6-owner-client-command', 'ai-w6-start', 'ai-w6-pointer', 'ai-w6-agent-receipt', 'ai-w6-fence-driver', 'ai-w6-human-revoke',
  'ai-w6-report', 'ai-w6-secret-close', 'ai-w7-approval', 'ai-mac-close',
];
// Blocks that the dry run must drive to exit 0. This proves the harness reaches the
// command paths instead of refusing every block at its first line.
const MUST_PASS = [
  'ai-inputs', 'ai-prepare', 'ai-extract', 'ai-edge-receipt', 'ai-gates', 'ai-live-controls', 'ai-w2-stage-probes', 'ai-w5-preflight', 'ai-w5-reference', 'ai-w6-readiness',
  'ai-w6-readiness-transfer', 'ai-w6-activation-approval', 'ai-w6-preflight', 'ai-w6-prepare', 'ai-w6-transfer',
  'ai-w6-start', 'ai-w6-pointer', 'ai-w6-agent-receipt', 'ai-w6-secret-close', 'ai-w7-approval', 'ai-mac-close',
];
// Blocks that contact public ingress from Python urllib; the sandbox denies the network.
const NETWORK_DENIED = ['ai-ordinary-probes', 'ai-w3-probes', 'ai-w4-probes', 'ai-w5-closed', 'ai-w6-activation-probes'];

// Command-position GUI launches in executable block text. Prose and Python string values
// (e.g. the 'headless-bundled-chromium' authorization value) are not command positions.
const GUI_SOURCE = [
  /\/Applications\b/, /~\/Applications\b/, /\$HOME\/Applications\b/, /Google Chrome/, /Chromium\.app/,
  /(^|[;&|`(]|\$\(|\bexec\s+|\bthen\s+|\bdo\s+)\s*(open|osascript|google-chrome|chromium(-browser)?|chrome)(\s|$)/m,
  /\bwebbrowser\b/, /\bLaunchServices\b/, /\bexec(File)?(Sync)?\(\s*['"](open|osascript)['"]/,
  /subprocess\.\w+\(\s*\[\s*['"](open|osascript)['"]/,
];
const executableText = (source: string) => source.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
const guiSourceHits = (source: string) => GUI_SOURCE.filter(re => re.test(executableText(source))).map(String);

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const realHome = realpathSync(homedir());
const outsideHome = (path: string) => path !== realHome && !path.startsWith(realHome + sep);
const temporaryRoot = realpathSync(tmpdir());
const scratch = realpathSync(mkdtempSync(join(temporaryRoot, 'c1gui-')));
assert.ok(outsideHome(scratch) && dirname(scratch) === temporaryRoot, `scratch ${scratch} must be a fresh temporary directory`);
// The scratch path is embedded into Python raw regexes and a sandbox profile string.
assert.match(scratch, /^\/[A-Za-z0-9/_-]+$/, 'scratch must be a plain path');
after(() => {
  assert.ok(dirname(scratch) === temporaryRoot && /^c1gui-[A-Za-z0-9]{6}$/.test(basename(scratch)) && outsideHome(scratch));
  rmSync(scratch, { recursive: true, force: true });
});

const stubDir = join(scratch, 'stubs');
const stubLogDir = join(scratch, 'stub-argv');
const blockDir = join(scratch, 'blocks');
const profileDir = join(scratch, 'profiles');
const workRoot = join(scratch, 'work');                 // stands in for /Users/yulanbot/work
const privateTmp = join(scratch, 'private-tmp');        // stands in for /private/tmp
const blockTmp = join(scratch, 'tmp');                  // TMPDIR: bash 3.2 writes each heredoc here
for (const dir of [stubDir, stubLogDir, blockDir, profileDir, workRoot, privateTmp, blockTmp]) mkdirSync(dir, { recursive: true, mode: 0o700 });

// Countable literal rewrites, as in tests/admin-release-plan.test.ts portable().
const REWRITES: Array<[string, string]> = [
  ['/Users/yulanbot/.local/bin/rm', join(stubDir, 'rm')],
  ['/Users/yulanbot/work/', workRoot + '/'],
  ['/private/tmp/', privateTmp + '/'],
];
function portable(source: string) {
  const counts: Record<string, number> = {};
  let result = source;
  for (const [from, to] of REWRITES) {
    counts[from] = result.split(from).length - 1;
    result = result.split(from).join(to);
  }
  for (const [from] of REWRITES) assert.ok(!result.includes(from), `rewrite left ${from}`);
  assert.ok(!result.includes('/Users/yulanbot/'), 'a real home path survived the fixture rewrite');
  return { result, counts };
}

// ---- Fixtures (synthetic, nonsecret) -------------------------------------------------
const releaseSha = 'a'.repeat(40), siteSha = 'f'.repeat(40), hex = 'b'.repeat(64);
const windowId = 'Dry0R1';
const probeWorkspace = 'c2ea0541-f56d-4c73-bf71-56c5405c4934';
// The release archive is a real tar carrying the producer: ai-live-controls (W5 opening
// and close) reads the producer only from it, re-verified against archive_sha256.
const producerFile = join(scratch, 'live-ordinary-controls.mjs');
writeFileSync(producerFile, 'export const dryRunProducer = "live-ordinary-controls";\n');
const archiveFile = join(scratch, 'release.tar');
// It also carries the companion SITE-RELEASE.md: ai-w5-reference reads the site plan only from it.
const madeArchive = spawnSync('/usr/bin/python3', ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t:\n    t.add(sys.argv[2],arcname="scripts/live-ordinary-controls.mjs"); t.add(sys.argv[3],arcname="docs/evidence/2026-10-02-site-release/SITE-RELEASE.md")', archiveFile, producerFile, sitePlanPath], { encoding: 'utf8' });
assert.equal(madeArchive.status, 0, madeArchive.stderr);
const archiveBytes = readFileSync(archiveFile);
const evidenceRoot = join(scratch, 'evidence'); mkdirSync(evidenceRoot, { mode: 0o700 });
const contract = JSON.parse(readFileSync(join(directory, 'GATES.json'), 'utf8')) as { gates: Record<string, string[]> };
const receipt = { release_sha: releaseSha, evidence_root: evidenceRoot, gates: {} as Record<string, unknown> };
for (const [name, controls] of Object.entries(contract.gates)) {
  const file = `${name}.txt`, bytes = `PASS dry-run fixture evidence for ${name}\n`;
  writeFileSync(join(evidenceRoot, file), bytes);
  receipt.gates[name] = { status: 'PASS', controls, file, sha256: digest(bytes) };
}
const gateReceiptFile = join(scratch, 'gate-receipt.json');
writeFileSync(gateReceiptFile, JSON.stringify(receipt) + '\n');
// The remote read-only query returns an independent, current box observation.
const edgeTarget = '/home/commonswarm/edge/releases/' + releaseSha;
const edgeMeasurement = { release_sha: releaseSha, target: edgeTarget, mount: edgeTarget,
  image_digest: `sha256:${hex}`, artifact_digest: hex, generation: 8, invalidated_at: null };
const edgeMeasurementFile = join(scratch, 'edge-measurement.json');
writeFileSync(edgeMeasurementFile, JSON.stringify(edgeMeasurement) + '\n');
const edgeObserved = JSON.stringify({ release_generation: 8, measured_generation: 8, invalidated_at: null,
  approved_edge_release_sha: releaseSha, measured_edge_release_sha: releaseSha,
  measured_edge_target: edgeTarget, measured_mount: edgeTarget, measured_image_digest: `sha256:${hex}`,
  measured_artifact_digest: hex });
const windowOf = (step: string) => /^ai-w2-/.test(step) ? 'W2' : /^ai-w5-/.test(step) ? 'W5' : /^ai-w6-/.test(step) ? 'W6' : /^ai-w7-/.test(step) ? 'W7' : 'W3';
function inputsFor(window: string) {
  const d: Record<string, unknown> = {
    release_sha: releaseSha, plan_sha256: digest(plan), archive_sha256: digest(archiveBytes),
    window, window_id: windowId, window_end_utc: new Date(Date.now() + 1_500_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    baseline_oauth_sha: 'c'.repeat(40), baseline_oauth_image: `sha256:${hex}`,
    baseline_edge_sha: 'd'.repeat(40), baseline_edge_image: `sha256:${hex}`,
    baseline_stack_sha: 'e'.repeat(40), baseline_postgres_image: `sha256:${hex}`,
    baseline_site_sha: siteSha, baseline_site_target: '/srv/commonswarm/site/releases/20261003T120000Z-ffffffffffff-abcdef0123456789',
    baseline_mcp_caddy_sha256: hex, baseline_api_caddy_sha256: hex, baseline_caddyfile_sha256: hex,
    baseline_ledger_sha256: hex, gate_receipt_sha256: digest(readFileSync(gateReceiptFile)),
    rollback_decision: { W2: 'retain-additive', W3: 'restore-service', W5: 'restore-service', W6: 'close-and-reconcile', W7: 'close-and-reconcile' }[window],
    approval: null, legacy_fence_approval: null,
    edge_recycle_service: 'fixture-edge-recycle.service', edge_recycle_timer: 'fixture-edge-recycle.timer', edge_recycle_sha256: hex,
  };
  if (window === 'W2') d.probe_workspace_id = probeWorkspace;
  // W6 names the W2b (release and window) that provisioned the issuer credential; it may be an earlier release.
  if (window === 'W6') { d.w2b_release_sha = 'd'.repeat(40); d.w2b_window_id = 'W2bFx1'; }
  // W7 names the same-release W6 whose C1 report it binds (lane/w6-ready).
  if (window === 'W7') d.w6_window_id = 'W6win1';
  const action = { W6: 'activate-admin-issuance-and-smoke', W7: 'retire-legacy-admin-mint' }[window];
  if (action) d.approval = { approver: 'HezLead', action, release_sha: releaseSha, window_id: windowId, plan_sha256: digest(plan), prompt_ref: 'task/dry-run-fixture' };
  const path = join(scratch, `inputs-${window}.json`);
  writeFileSync(path, JSON.stringify(d) + '\n');
  return path;
}
const siteQaFile = join(scratch, 'site-qa.json');
writeFileSync(siteQaFile, JSON.stringify({ approver: 'HezLead', release_sha: releaseSha, task_ref: 'task/dry-run-fixture', browser: 'headless-bundled-chromium' }) + '\n');
// W5 closed directory and a BROWSER-READY marker newer than the close.
const w5Dir = join(scratch, 'w5'); mkdirSync(w5Dir, { mode: 0o700 });
writeFileSync(join(w5Dir, 'inputs.json'), JSON.stringify({ release_sha: releaseSha, window: 'W5' }) + '\n');
writeFileSync(join(w5Dir, 'W5-closed.json'), JSON.stringify({ state: 'closed', site_ownership_close: 'PASS' }) + '\n');
writeFileSync(join(w5Dir, 'closed.txt'), new Date(Date.now() - 120_000).toISOString().replace(/\.\d{3}Z$/, 'Z') + '\n');
const browserReady = join(workRoot, 'BROWSER-READY');
writeFileSync(browserReady, 'dry-run fixture\n');
utimesSync(browserReady, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
// Site evidence with a valid close and manifest, so ai-w5-closed reaches its network step.
const siteEvidence = join(scratch, 'site-evidence'); mkdirSync(siteEvidence, { mode: 0o700 });
writeFileSync(join(siteEvidence, 'index.html'), '<!doctype html>\n');
writeFileSync(join(siteEvidence, 'manifest.json'), JSON.stringify([{ path: 'index.html', sha256: digest('<!doctype html>\n') }]));
writeFileSync(join(siteEvidence, 'CLOSE.txt'), `CLOSED=yes\nOUTCOME=released\nPIN_RELEASED=yes\nMANIFEST_SHA256=${digest(readFileSync(join(siteEvidence, 'manifest.json')))}\n`);
// W5 forward close (Amendments A/B): a phase-after live receipt bound to the post-W5
// consent receipt, so ai-w5-closed passes ai-live-controls and still reaches its network step.
const consentText = JSON.stringify({ kind: 'c1-consent', release_sha: releaseSha, consent_phase: 'post-W5',
  measured_at: new Date(Date.now() - 60_000).toISOString(), producer_sha256: digest(readFileSync(producerFile)),
  controls: { cimd_consent: true, dcr_registration_consent: true }, dcr_client_ids: ['dry-run-post-w5'],
  cleanup: { grants_revoked: true, dcr_clients_expiring: [{ client_id: 'dry-run-pre-w1', expires_after: new Date(Date.now() + 30 * 86400_000).toISOString() }] } });
const liveControlsProof = join(scratch, 'live-controls-proof'); mkdirSync(liveControlsProof, { mode: 0o700 });
const consentFile = join(scratch, 'consent-post-W5.json'); writeFileSync(consentFile, consentText);
const liveControlsFile = join(scratch, 'live-W5-after.json');
writeFileSync(liveControlsFile, JSON.stringify({ release_sha: releaseSha, window_id: windowId, window: 'W5', phase: 'after',
  controls: { hosted_mcp_consent_refresh: true, dcr_registration_consent: true, cimd_consent: true, human_recovery: true, worker_command_read: true },
  consent_receipt_sha256: digest(consentText), producer_sha256: digest(readFileSync(producerFile)), dcr_client_ids: ['dry-run-w5-after'] }));
// W5 opening: a phase-before live receipt bound to the pre-W1 consent receipt (ai-w5-preflight).
const preConsentText = JSON.stringify({ kind: 'c1-consent', release_sha: releaseSha, consent_phase: 'pre-W1',
  measured_at: new Date(Date.now() - 60_000).toISOString(), producer_sha256: digest(readFileSync(producerFile)),
  controls: { cimd_consent: true, dcr_registration_consent: true }, dcr_client_ids: ['dry-run-pre-w1'], cleanup: null });
const preConsentFile = join(scratch, 'consent-pre-W1.json'); writeFileSync(preConsentFile, preConsentText);
const liveBeforeFile = join(scratch, 'live-W5-before.json');
writeFileSync(liveBeforeFile, JSON.stringify({ release_sha: releaseSha, window_id: windowId, window: 'W5', phase: 'before',
  controls: { hosted_mcp_consent_refresh: true, dcr_registration_consent: true, cimd_consent: true, human_recovery: true, worker_command_read: true },
  consent_receipt_sha256: digest(preConsentText), producer_sha256: digest(readFileSync(producerFile)), dcr_client_ids: ['dry-run-w5-before'] }));
// C1 inputs: synthetic owner/workspace, fixture target file (no key) and state directory.
const c1Dir = join(scratch, 'c1'); mkdirSync(join(c1Dir, 'state'), { recursive: true, mode: 0o700 });
writeFileSync(join(c1Dir, 'target.json'), JSON.stringify({ url: 'https://api.commonswarm.com', anonKey: 'dry-run-fixture-not-a-key' }) + '\n');
const c1InputsFile = join(c1Dir, 'C1-inputs.json');
writeFileSync(c1InputsFile, JSON.stringify({
  release_sha: releaseSha, window_id: windowId, plan_sha256: digest(plan),
  owner_user_id: '00000000-0000-4000-8000-000000000001', smoke_workspace_id: '00000000-0000-4000-8000-000000000002',
  smoke_workspace_name: 'Dry run smoke workspace', verification_version: 1, metadata_digest: hex,
  target_file: join(c1Dir, 'target.json'), state_directory: join(c1Dir, 'state'),
}) + '\n');
const c1ProofDir = join(workRoot, 'hm37-live-release', `c1-${releaseSha}-${windowId}`);
// W2 probe credentials (synthetic) at the rewritten Mac path; ai-w2-stage-probes uploads and removes them.
mkdirSync(join(workRoot, 'c1-run'), { recursive: true, mode: 0o700 });
writeFileSync(join(workRoot, 'c1-run', `probe-credentials-W2-${windowId}.json`), JSON.stringify({ release_sha: releaseSha, window_id: windowId,
  workspace_id: probeWorkspace, mcp_client_id: 'dry-run-dcr-client', mcp_refresh_token: 'dry-run-not-a-token', mcp_resource: 'https://mcp.commonswarm.com/mcp',
  human_access_token: 'dry-run-not-a-token', human_token_exp: Math.floor(Date.now() / 1000) + 7200 }), { mode: 0o600 });
const fixturePrepDir = join(privateTmp, 'admin-issuance-prep.Fixtu1');
mkdirSync(fixturePrepDir, { mode: 0o700 }); chmodSync(fixturePrepDir, 0o700);
const fixtureStage = join(privateTmp, 'anvil-secret.Fixtu2');
mkdirSync(fixtureStage, { mode: 0o700 }); chmodSync(fixtureStage, 0o700);
const specScope = /\bworkspaces:create\b/.test(readFileSync(specPath, 'utf8')) ? 'workspaces:create' : 'admin:read';
const requestPlan = JSON.stringify({ client_id: 'https://commonswarm.com/oauth/c1-smoke/client.json', resource: 'https://api.commonswarm.com/admin', scope: `openid offline_access ${specScope}` });
const clientMetadata = JSON.stringify({ client_id: 'https://commonswarm.com/oauth/c1-smoke/client.json', redirect_uris: ['https://commonswarm.com/oauth/c1-smoke/callback'] });
const agentReceipt = JSON.stringify({ ok: true, run_id: '0123456789abcdef', workspace: { name: 'Dry run smoke workspace', accepted_residue: true }, steps: ['dry-run'], refused_after_fence: { http_status: 401, refusal_code: 'dry_run' }, failed_step: null, failure_code: null });

// ---- Stubs ----------------------------------------------------------------------------
// Fake output is documented per case. Anything else is refused with exit 97 (fail closed);
// GUI launchers are refused with exit 96 unless the `open -a` model execs a binary under
// an active sandbox, which the kernel must deny.
const DISPATCH = `#!/bin/bash
set -u
name=\${0##*/}
{ printf '%s' "$name"; printf ' %q' "$@"; printf '\\n'; } >>"$C1GUI_STUB_LOG"
refuse() { printf 'c1gui stub refused unmodelled %s\\n' "$name" >&2; exit 97; }
case "$name" in
 ssh) # Remote commands are recorded only. 'sudo -n cat FILE' prints a fixture receipt line.
  last=\${@: -1}
  # W2 probe upload: consume stdin and answer with the mode and digest of what arrived (nothing is stored).
  case "$last" in *ordinary-probes.json*install*/dev/stdin*) printf '600 %s\\n' "$(/usr/bin/shasum -a 256 | cut -d ' ' -f 1)"; exit 0;; esac
  if test "$last" = "sudo -n /bin/bash -s -- $C1GUI_RELEASE_SHA $C1GUI_POSTGRES_IMAGE"; then
   # Consume the query, but never execute its box-only secret/Docker commands.
   query=$(/bin/cat)
   case "$query" in *'SET default_transaction_read_only=on;'*'release_generation,measured_generation,invalidated_at'*) ;;
    *) refuse;; esac
   printf '%s\\n' "$C1GUI_EDGE_OBSERVED"; exit 0
  fi
  case "$last" in "sudo -n cat "*) printf 'PASS dry-run fixture receipt\\n';; esac
  exit 0;;
 scp|rsync) exit 0;;  # Recorded transfer; nothing leaves this host.
 git)
  case "\${1:-}" in
   fetch) exit 0;;                                  # network op: recorded, not performed
   status) test "\${2:-}" = --porcelain && exit 0; refuse;;  # clean tree
   remote) test "\${2:-} \${3:-}" = 'get-url origin' && { echo git@github.com:yulanventures/commonswarm.git; exit 0; }; refuse;;
   rev-parse)
    test "\${2:-}" = HEAD && { echo "$C1GUI_RELEASE_SHA"; exit 0; }
    if test "\${2:-}" = --verify; then
     ref=\${3%'^{commit}'}
     test \${#ref} -ge 7 || exit 128
     for sha in $C1GUI_KNOWN_SHAS; do case "$sha" in "$ref"*) echo "$sha"; exit 0;; esac; done
     exit 128
    fi
    refuse;;
   merge-base) test "\${2:-}" = --is-ancestor && exit 0; refuse;;
   archive) exec /bin/cat "$C1GUI_ARCHIVE";;  # fixed tar bytes; inputs carry their digest
   show)
    case "\${2:-}" in
     *:docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md) exec /bin/cat "$C1GUI_PLAN";;
     *:docs/evidence/2026-10-02-site-release/SITE-RELEASE.md) exec /bin/cat "$C1GUI_SITE_PLAN";;
     *:scripts/live-ordinary-controls.mjs) exec /bin/cat "$C1GUI_PRODUCER";;
    esac
    refuse;;
  esac
  refuse;;
 node)
  case " $* " in *" --import tsx "*|*" --import=tsx "*)
   printf 'c1gui stub refused node --import tsx (reads credential state or contacts services)\\n' >&2; exit 97;;
  esac
  if test "\${1:-}" = scripts/admin-smoke.mjs; then
   case "\${2:-}" in
    --dry-run) printf '%s\\n' "$C1GUI_REQUEST_PLAN"; exit 0;;
    --print-client-metadata) printf '%s\\n' "$C1GUI_CLIENT_METADATA"; exit 0;;
    --authorize-url-file)  # runner model: write the fixture receipt, contact nothing
     receipt=; while test $# -gt 0; do test "$1" = --receipt-file && receipt=$2; shift; done
     test -n "$receipt" || refuse
     printf '%s\\n' "$C1GUI_AGENT_RECEIPT" >"$receipt"; exit 0;;
   esac
   refuse
  fi
  test $# -eq 2 && test "$1" = -e && test "$2" = 'console.log(require("node:crypto").randomUUID())' && exec "$C1GUI_REAL_NODE" "$@"
  test $# -ge 2 && test "$1" = --input-type=module && test "$2" = - && exec "$C1GUI_REAL_NODE" "$@"
  refuse;;
 open)
  if test "\${1:-}" = -a && test -n "\${2:-}"; then
   bin="/Applications/$2.app/Contents/MacOS/$2"
   # Model open -a by exec'ing the app binary directly. Never via LaunchServices.
   # Refuse unless the sandbox is provably active: the keychain read must be denied.
   probe=$(/bin/ls "$HOME/Library/Keychains" 2>&1 >/dev/null)
   case "$probe" in *'Operation not permitted'*) ;; *) printf 'c1gui open stub: sandbox inactive; refusing\\n' >&2; exit 98;; esac
   test -e "$bin" || { printf 'c1gui open stub: %s absent\\n' "$bin" >&2; exit 99; }
   "$bin"; exit $?  # forked exec: the kernel answers EPERM and bash exits 126
  fi
  printf 'c1gui stub refused GUI open\\n' >&2; exit 96;;
 osascript|google-chrome|chrome|chromium|chromium-browser|Google\\ Chrome) printf 'c1gui stub refused GUI %s\\n' "$name" >&2; exit 96;;
 rm)  # Guarded rm: every operand must resolve inside the dry run's temporary root.
  for arg in "$@"; do
   case "$arg" in -*) continue;; esac
   case "$arg" in "$C1GUI_SCRATCH"/*) ;; *) printf 'c1gui rm refused %s\\n' "$arg" >&2; exit 1;; esac
  done
  exec /bin/rm "$@";;
esac
refuse
`;
const STUBS = ['ssh', 'scp', 'rsync', 'git', 'node', 'open', 'osascript', 'google-chrome', 'chrome', 'chromium', 'chromium-browser', 'Google Chrome', 'rm',
  'docker', 'curl', 'wget', 'op', 'psql', 'sudo', 'security', 'launchctl', 'npm', 'npx', 'cswarm'];
writeFileSync(join(stubDir, '_dispatch'), DISPATCH, { mode: 0o755 });
for (const name of STUBS) symlinkSync('_dispatch', join(stubDir, name));
const realNode = realpathSync(process.execPath);
assert.doesNotMatch(realNode, /\/Applications\//, 'node must not live under an Applications folder');

// ---- Sandbox ----------------------------------------------------------------------------
const nonce = randomBytes(6).toString('hex');
const heredocDir = realpathSync(repo);
assert.match(heredocDir, /^\/[A-Za-z0-9/_.-]+$/, 'repository path must be plain for the heredoc rule');
const tag = (kind: string, id: string) => `c1gui-${nonce}-${kind}-${id}`;
const sbString = (path: string) => { assert.ok(!/["\\\n\r]/.test(path), `unsafe profile path ${path}`); return `"${path}"`; };
function profile(id: string) {
  const text = `(version 1)
(allow default)
(deny process-exec (with message "${tag('exec', id)}")
  (subpath "/Applications") (subpath ${sbString(join(realHome, 'Applications'))})
  (regex #"/Google Chrome[^/]*$") (regex #"/[Cc]hromium[^/]*$"))
(deny file-read* (with message "${tag('read', id)}")
  (subpath ${sbString(join(realHome, 'Library/Application Support/Google/Chrome'))})
  (subpath ${sbString(join(realHome, 'Library/Keychains'))}))
(deny network* (with message "${tag('net', id)}"))
(deny file-write*)
(allow file-write* (subpath ${sbString(scratch)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (subpath "/dev/fd")
  ;; Apple bash 3.2 ignores TMPDIR for here-documents; with /tmp unwritable it falls back to
  ;; the working directory. Allow only its transient sh-thd-<n> files there.
  (regex #"^${heredocDir.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')}/sh-thd-[0-9]+$"))
`;
  const path = join(profileDir, `${id}.sb`);
  writeFileSync(path, text);
  return path;
}
const baseEnv = () => ({
  PATH: `${stubDir}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: process.env.HOME ?? realHome, LANG: 'en_US.UTF-8', TMPDIR: blockTmp + '/',
  C1GUI_SCRATCH: scratch, C1GUI_RELEASE_SHA: releaseSha, C1GUI_KNOWN_SHAS: `${releaseSha} ${siteSha}`,
  C1GUI_PLAN: planPath, C1GUI_SITE_PLAN: sitePlanPath, C1GUI_PRODUCER: producerFile, C1GUI_ARCHIVE: archiveFile, C1GUI_REAL_NODE: realNode,
  C1GUI_POSTGRES_IMAGE: `sha256:${hex}`, C1GUI_EDGE_OBSERVED: edgeObserved,
  C1GUI_REQUEST_PLAN: requestPlan, C1GUI_CLIENT_METADATA: clientMetadata, C1GUI_AGENT_RECEIPT: agentReceipt,
});
// One argv log per block: a background child (the ai-w6-start runner) inherits its own
// block's log, so attribution does not depend on timing.
const stubLogOf = (id: string) => join(stubLogDir, `${id}.log`);
const stubRecords = (id: string) => existsSync(stubLogOf(id)) ? readFileSync(stubLogOf(id), 'utf8').split('\n').filter(Boolean) : [];
const GUI_STUB = /^(open|osascript|google-chrome|chrome|chromium|chromium-browser|Google Chrome)( |$)/;
type Outcome = { id: string; step: string; status: number | null; signal: string | null; stdout: string; stderrTail: string; stubCalls: string[]; rewrites: Record<string, number>; sandboxDenied: boolean };
function runSandboxed(id: string, step: string, source: string, env: Record<string, string>): Outcome {
  const { result, counts } = portable(source);
  const file = join(blockDir, `${id}.sh`);
  writeFileSync(file, result);
  const run = spawnSync('/usr/bin/sandbox-exec', ['-f', profile(id), '/bin/bash', file], {
    cwd: repo, env: { ...baseEnv(), ...env, C1GUI_STUB_LOG: stubLogOf(id) }, encoding: 'utf8', timeout: 60_000,
  });
  assert.notEqual(run.status, 65, `${step}: sandbox profile did not compile: ${run.stderr}`);
  assert.notEqual(run.status, 71, `${step}: sandbox could not be applied (already inside another sandbox?): ${run.stderr}`);
  const stderr = run.stderr ?? '';
  return {
    id, step, status: run.status, signal: run.signal, rewrites: counts, stdout: run.stdout ?? '',
    stderrTail: stderr.trim().split('\n').slice(-1)[0] ?? '',
    stubCalls: stubRecords(id),
    sandboxDenied: /(\/Applications\/|Chrom).*Operation not permitted/.test(stderr),
  };
}
function localTimestamp(date: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}
function kernelDenials(since: Date) {
  const shown = spawnSync('/usr/bin/log', ['show', '--start', localTimestamp(since), '--style', 'compact',
    '--predicate', `eventMessage CONTAINS "c1gui-${nonce}"`], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(shown.status, 0, `log show failed: ${shown.stderr}`);
  return [...shown.stdout.matchAll(new RegExp(`c1gui-${nonce}-(exec|read|net)-([a-z0-9-]+)`, 'g'))].map(m => ({ kind: m[1]!, id: m[2]! }));
}

// ---- Tests ------------------------------------------------------------------------------
test('gui-denied dry run: Mac host blocks are extracted completely and reconciled against the plan', { skip }, () => {
  assert.ok(blocks.length >= 30, 'unexpectedly incomplete extraction');
  for (const source of blocks) {
    assert.ok(stepOf(source), `unmarked block: ${source.split('\n')[0]}`);
    assert.ok(hostOf(source), `${stepOf(source)} has no # host: line`);
  }
  assert.deepEqual(macBlocks.map(stepOf), EXPECTED_MAC_STEPS, 'Mac host block set changed; reconcile EXPECTED_MAC_STEPS');
  const excluded = blocks.filter(s => !macBlocks.includes(s)).map(stepOf);
  assert.equal(excluded.length + macBlocks.length, blocks.length);
  for (const source of blocks.filter(s => !macBlocks.includes(s))) assert.doesNotMatch(hostOf(source)!, /mac/i);
  console.log(`# Mac blocks ${macBlocks.length} of ${blocks.length}; box-only blocks excluded: ${excluded.join(' ')}`);
});

test('gui-denied dry run: no Mac block names a GUI launcher; the scanner flags an injected one', { skip }, () => {
  for (const source of macBlocks) assert.deepEqual(guiSourceHits(source), [], `${stepOf(source)} names a GUI launcher`);
  // Positive controls for the static scanner.
  assert.notDeepEqual(guiSourceHits('set -e\nopen -a "Google Chrome"\n'), []);
  assert.notDeepEqual(guiSourceHits('x=1; osascript -e "beep"\n'), []);
  assert.notDeepEqual(guiSourceHits('python3 -c "import webbrowser"\n'), []);
  assert.notDeepEqual(guiSourceHits('"$HOME/Applications/Foo.app/Contents/MacOS/Foo"\n'), []);
});

test('gui-denied dry run: every Mac block runs sandboxed with stubs; none attempts GUI exec; injected open -a "Google Chrome" is denied', { skip }, () => {
  const started = new Date(Date.now() - 2_000);
  const outcomes: Outcome[] = [];
  let prepDir = fixturePrepDir, stage = fixtureStage, runnerPid = '2147483646';
  macBlocks.forEach((source, index) => {
    const step = stepOf(source)!;
    const env: Record<string, string> = {
      INPUTS_FILE: inputsFor(windowOf(step)), PLAN_FILE: planPath, GATE_RECEIPT_FILE: gateReceiptFile,
      EDGE_MEASUREMENT_FILE: edgeMeasurementFile, EDGE_RECEIPT_REMOTE: '1',
      PREP_DIR: prepDir, STEP_ID: 'ai-inputs', RELEASE_SHA: releaseSha, WINDOW_ID: windowId,
      SITE_RELEASE_SHA: releaseSha, EXPECTED_SITE_SHA: siteSha, SITE_QA_AUTHORIZATION_FILE: siteQaFile,
      SITE_STEP: 'site2-plan-inputs', SITE_RELEASE_REPO: repo, SITE_EVIDENCE: siteEvidence,
      LIVE_CONTROLS_FILE: step === 'ai-w5-preflight' ? liveBeforeFile : liveControlsFile,
      CONSENT_RECEIPT_FILE: step === 'ai-w5-preflight' ? preConsentFile : consentFile,
      W5_CLOSED_FILE: join(w5Dir, 'closed.txt'), BROWSER_READY_FILE: browserReady,
      // ai-live-controls also runs in the W5 Mac shell: validate the W5 after pair, producer
      // read from the verified release tar, retained copies in a task-owned proof directory.
      ...(step === 'ai-live-controls' ? { INPUTS_FILE: inputsFor('W5'), BOX_ARCHIVE_PATH: archiveFile, PROOF_DIR: liveControlsProof } : {}),
      // withdraw: the approve mode first requires the pointer that ai-w6-pointer publishes later.
      C1_INPUTS_FILE: c1InputsFile, C1_PROOF_DIR: c1ProofDir, C1_CLIENT_ACTION: 'withdraw',
      C1_TRANSFER_DIRECTION: 'download', C1_TRANSFER_FILE: 'C1-client-check.txt',
      C1_SECRET_STAGE: stage, C1_POINTER: join(workRoot, 'dcr-rt', 'c1-smoke.pointer'), C1_RUNNER_PID: runnerPid,
    };
    const outcome = runSandboxed(String(index), step, source, env);
    outcomes.push(outcome);
    // Carry forward state the plan keeps in one Mac shell.
    const prepared = /PASS ai-prepare: archive retained at (\S+);/.exec(outcome.stdout)?.[1];
    if (step === 'ai-prepare' && prepared) prepDir = prepared;
    if (step === 'ai-w6-start' && existsSync(join(c1ProofDir, 'secret-stage.path'))) {
      stage = readFileSync(join(c1ProofDir, 'secret-stage.path'), 'utf8').trim();
      runnerPid = readFileSync(join(c1ProofDir, 'runner.pid'), 'utf8').trim();
    }
  });

  // Positive control: an injected block calling open -a "Google Chrome" through the same
  // harness. The open stub models it as a direct exec, which the kernel must refuse.
  const control = runSandboxed('control', 'injected-open-chrome', '# step: ai-injected-control\n# readonly: no\n# host: Mac\nset -euo pipefail\nopen -a "Google Chrome"\n', {});
  // Control for the control: an ordinary task-owned executable still runs in the same sandbox.
  const allowedBin = join(scratch, 'allowed-tool');
  writeFileSync(allowedBin, '#!/bin/bash\necho allowed\n', { mode: 0o755 });
  const allowed = runSandboxed('allowed', 'allowed-exec', `set -euo pipefail\n${allowedBin}\n`, {});

  let denials = kernelDenials(started);
  for (let i = 0; i < 20 && !denials.some(d => d.kind === 'exec' && d.id === 'control'); i++) {
    spawnSync('/bin/sleep', ['1']);
    denials = kernelDenials(started);
  }

  for (const o of [...outcomes, control, allowed]) o.stubCalls = stubRecords(o.id);
  for (const o of outcomes) {
    console.log(`# ${o.step}: exit=${o.status}${o.signal ? ` signal=${o.signal}` : ''} rewrites=${JSON.stringify(o.rewrites)} stubs=[${o.stubCalls.map(c => c.split(' ')[0]).join(',')}] last=${JSON.stringify(o.stderrTail.slice(0, 160))}`);
  }
  console.log(`# control: exit=${control.status} stubs=${JSON.stringify(control.stubCalls)} last=${JSON.stringify(control.stderrTail)}`);
  console.log(`# kernel denials tagged c1gui-${nonce}: ${JSON.stringify(denials)}`);
  console.log(`# stub executables: ${STUBS.join(', ')}`);

  // Every Mac block ran under the sandbox and none attempted a GUI launch.
  assert.equal(outcomes.length, EXPECTED_MAC_STEPS.length);
  for (const o of outcomes) {
    assert.ok(o.status !== null, `${o.step} timed out or was killed (${o.signal})`);
    assert.deepEqual(o.stubCalls.filter(c => GUI_STUB.test(c)), [], `${o.step} called a GUI launcher stub`);
    assert.equal(o.sandboxDenied, false, `${o.step} hit a GUI exec denial: ${o.stderrTail}`);
    assert.equal(denials.filter(d => d.id === o.id && d.kind !== 'net').length, 0, `${o.step} has GUI-exec/keychain kernel denials`);
  }
  const byStep = new Map(outcomes.map(o => [o.step, o]));
  for (const step of MUST_PASS) assert.equal(byStep.get(step)!.status, 0, `${step} must complete in the dry run: ${byStep.get(step)!.stderrTail}`);
  assert.equal(byStep.get('ai-edge-receipt')!.stubCalls.length, 1);
  assert.match(byStep.get('ai-edge-receipt')!.stubCalls[0]!, /^ssh .*sudo/,
    'edge receipt must consume a modelled remote box observation');
  for (const step of NETWORK_DENIED) {
    const o = byStep.get(step)!;
    assert.notEqual(o.status, 0, `${step} reached the network`);
    assert.ok(denials.some(d => d.id === o.id && d.kind === 'net'), `${step} did not stop at the sandbox network denial`);
  }
  // Fail-closed stubs: the credential-reading owner client command is refused, never run.
  assert.ok(byStep.get('ai-w6-owner-client-command')!.stubCalls.some(c => /^node .*--import tsx/.test(c)));
  assert.notEqual(byStep.get('ai-w6-owner-client-command')!.status, 0);
  // Modelled external commands were actually exercised.
  const called = new Set(outcomes.flatMap(o => o.stubCalls.map(c => c.split(' ')[0])));
  for (const name of ['ssh', 'scp', 'git', 'node', 'rm']) assert.ok(called.has(name), `stub ${name} never exercised`);

  // Positive control: denied by the sandbox, recorded by the stub, and logged by the kernel.
  assert.deepEqual(control.stubCalls, ['open -a Google\\ Chrome']);
  assert.equal(control.status, 126, `control was not denied: ${control.stderrTail}`);
  assert.match(control.stderrTail, /\/Applications\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome: Operation not permitted/);
  assert.ok(denials.some(d => d.kind === 'exec' && d.id === 'control'), 'kernel log has no tagged process-exec denial for the control');
  assert.ok(denials.some(d => d.kind === 'read' && d.id === 'control'), 'kernel log has no tagged keychain read denial for the control');
  assert.equal(allowed.status, 0, `task-owned executable must run in the same sandbox: ${allowed.stderrTail}`);
  assert.ok(!denials.some(d => d.id === 'allowed'));

  // Nothing escaped the scratch root: no real ~/work output, no /private/tmp stage left.
  assert.ok(!existsSync(`/Users/yulanbot/work/hm37-live-release/c1-${releaseSha}-${windowId}`));
  assert.ok(!existsSync(`/Users/yulanbot/work/hm37-live-release/${releaseSha}-W5-${windowId}`));
  assert.deepEqual(readdirSync(heredocDir).filter(name => name.startsWith('sh-thd-')), [], 'here-document files left in the working directory');
});

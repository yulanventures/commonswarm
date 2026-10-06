/** Generator contract at its CLI boundary; no plan block is executed. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';

const generator = resolve('scripts/c1-task-from-plan.mjs');
const planPath = resolve('docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md');
const plan = readFileSync(planPath);
const text = plan.toString('utf8');
const root = realpathSync(tmpdir());
const scratch = mkdtempSync(join(root, 'c1-task-generator.'));
after(() => {
  assert.equal(dirname(scratch), root);
  assert.match(scratch.slice(root.length + 1), /^c1-task-generator\.[A-Za-z0-9]+$/);
  assert.equal(realpathSync(scratch), scratch);
  const removed = spawnSync('rm', ['-r', '--', scratch], { encoding: 'utf8' });
  assert.equal(removed.status, 0, `BLOCKED by rm guard: ${removed.stderr.trim()}. To resolve: leave ${scratch} for HezLead.`);
});

type Passage = { start_line: number; end_line: number; quote: string };
type Task = {
  header: { plan_sha256: string; window: string; mode: string; generator_version: string };
  order_evidence: Passage[];
  steps: { id: string; offset: number; length: number; start_line: number; end_line: number;
    host: string; readonly: string; block: string; conditions: Passage[]; execution_host: string; input?: string; manual?: Passage; dispatched_blocks?: Task["steps"]; ambiguity?: string; readings?: { source: Passage; steps: Task["steps"] }[] }[];
};
const run = (path: string, window = 'W3', mode = 'forward', output?: string) =>
  spawnSync(process.execPath, [generator, path, window, mode, ...(output ? [output] : [])], { encoding: 'utf8', timeout: 10_000 });
const fixture = (name: string, value: string | Buffer) => {
  const path = join(scratch, name); writeFileSync(path, value); return path;
};
const block = (id: string, command = 'printf hello\n') =>
  `\n\n\`\`\`sh\n# step: ${id}\n# readonly: yes\n# host: Mac\n${command}\`\`\`\n`;
const windows = ['W1', 'W2', 'W2b', 'W3', 'W4', 'W5', 'W6', 'W6e', 'W7'];
const modes = ['forward', 'rollback', 'recovered-close'];
const explicit = (steps: string) => {
  const ids = steps.split(' → ');
  const lines = ids.map(id => JSON.stringify({ id, host: 'mac' })).join('\n');
  return '## Run orders (machine-read by scripts/c1-task-from-plan.mjs)\n\n' +
    windows.flatMap(w => modes.map(m => `\`\`\`c1-order ${w} ${m}\n${lines}\n\`\`\`\n`)).join('\n') + '\n## Blocks\n';
};
const refusal = (path: string, window: string, mode: string, expected: string) => {
  const result = run(path, window, mode);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '', 'a refusal never emits a partial task');
  assert.equal(result.stderr, `FAIL c1-task-from-plan: ${expected}; STOP\n`);
};
function verify(task: Task, bytes: Buffer, window: string, mode: string) {
  assert.equal(task.header.plan_sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(task.header.window, window);
  assert.equal(task.header.mode, mode);
  assert.ok(task.header.generator_version);
  assert.ok(task.steps.length);
  const source = bytes.toString('utf8');
  const lines = source.split('\n');
  const quote = (p: Passage) => assert.ok(lines.slice(p.start_line - 1, p.end_line).join('\n').includes(p.quote), JSON.stringify(p));
  for (const evidence of task.order_evidence) quote(evidence);
  const visit = (steps: Task['steps']) => { for (const step of steps) {
    if (step.ambiguity) {
      assert.ok(step.readings!.length >= 2);
      for (const reading of step.readings!) { quote(reading.source); visit(reading.steps); }
      continue;
    }
    for (const condition of step.conditions) quote(condition);
    if (step.manual) { quote(step.manual); continue; }
    assert.deepEqual(Buffer.from(step.block), bytes.subarray(step.offset, step.offset + step.length));
    assert.equal(bytes.subarray(0, step.offset).toString('utf8').split('\n').length, step.start_line);
    assert.equal(step.block, lines.slice(step.start_line - 1, step.end_line).join('\n') + '\n');
    assert.ok(step.block.startsWith(`# step: ${step.id}\n`));
    assert.ok(step.block.split('\n').includes(step.host));
    assert.ok(step.block.split('\n').includes(step.readonly));
    visit(step.dispatched_blocks ?? []);
  } };
  visit(task.steps);
}

test('real plan: every one of 27 window/mode tasks retains exact blocks, manual text and conditions at their offsets', () => {
  const defined = new Set([...text.matchAll(/^# step: (ai-[a-z0-9-]+)$/gm)].map(m => m[1]));
  const used = new Set<string>();
  const visit = (steps: Task['steps']) => {
    for (const step of steps) {
      if (step.id) { assert.ok(defined.has(step.id)); used.add(step.id); }
      for (const r of step.readings ?? []) visit(r.steps);
      visit(step.dispatched_blocks ?? []);
    }
  };
  for (const window of windows) for (const mode of modes) {
    const result = run(planPath, window, mode);
    assert.equal(result.status, 0, `${window} ${mode}: ${result.stderr}`);
    const task: Task = JSON.parse(result.stdout);
    verify(task, plan, window, mode); visit(task.steps);
    assert.equal((task.header as any).requires_lead_ruling, false);
    assert.ok(task.steps.every(s => !s.ambiguity));
  }
  const excluded = new Set([...text.matchAll(/^not-run: (.+)$/gm)].map(m => JSON.parse(m[1]!).id));
  assert.deepEqual(new Set([...used, ...excluded]), defined, 'every definition is dispatched or explicitly excluded');
  assert.equal([...used].filter(id => excluded.has(id)).length, 0);
});

test('W3 forward retains the public-probe condition beside the actual probe and keeps measured ingress distinct from closed', () => {
  const result = run(planPath);
  assert.equal(result.status, 0, result.stderr);
  const task: Task = JSON.parse(result.stdout);
  const probe = task.steps.find(s => s.id === 'ai-w3-probes')!;
  assert.ok(probe);
  assert.equal(probe.execution_host, 'mac');
  assert.deepEqual(probe.conditions.map(p => p.quote), [
    'ai-w3-probes only if baseline Caddy already serves that route; W4 makes it\nmandatory with CORS. Baseline route availability is measured, never guessed.'
  ]);
  assert.ok(task.steps.findIndex(s => s.id === 'ai-w3-local-gate') < task.steps.indexOf(probe));
});

test('W5 pins companion bytes and starts the companion normal route with shared preflight', () => {
  const result = run(planPath, 'W5', 'forward');
  assert.equal(result.status, 0, result.stderr);
  const task = JSON.parse(result.stdout);
  const site = readFileSync('docs/evidence/2026-10-02-site-release/SITE-RELEASE.md');
  assert.equal(task.header.site_plan.sha256, createHash('sha256').update(site).digest('hex'));
  assert.equal(task.header.requires_lead_ruling, false);
  const contract = JSON.parse(/```release-contract\n([\s\S]*?)\n```/.exec(site.toString())![1]!);
  const selected = task.steps.filter((s: any) => s.id === 'ai-w5-reference');
  assert.deepEqual(selected.map((s: any) => s.input.split(';')[0].replace('SITE_STEP=', '')), contract.routes.normal);
});

test('synthetic order, edited block, file output and UTF-8 offsets are observable at the CLI', () => {
  const before = 'π: generated from plan\n' + explicit('ai-beta → ai-alpha → ai-beta') + block('ai-alpha') + block('ai-beta');
  const path = fixture('positive.md', before);
  const result = run(path);
  assert.equal(result.status, 0, result.stderr);
  const task: Task = JSON.parse(result.stdout);
  verify(task, Buffer.from(before), 'W3', 'forward');
  // Order comes from the table rather than definition order, and repeats stay.
  assert.equal(task.steps.map(s => s.id).join(' → '), 'ai-beta → ai-alpha → ai-beta');
  const edited = before.replaceAll('printf hello', 'printf goodbye');
  const changed = run(fixture('edited.md', edited));
  assert.equal(changed.status, 0, changed.stderr);
  verify(JSON.parse(changed.stdout), Buffer.from(edited), 'W3', 'forward');
  assert.notEqual(result.stdout, changed.stdout);
  const output = join(scratch, 'task.json');
  const written = run(path, 'W3', 'forward', output);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.stdout, '');
  assert.equal(readFileSync(output, 'utf8'), result.stdout);
  assert.equal(run(path, 'W3', 'forward', output).status, 1, 'an existing task is never overwritten');
});

test('missing orders, undefined/unaccounted steps, wrong quotes, duplicates and invalid inputs refuse exactly', () => {
  const positive = explicit('ai-present') + block('ai-present');
  const control = fixture('control.md', positive);
  assert.equal(run(control).status, 0, 'same-invocation positive control reaches new section parser');
  const missing = positive.replace(/```c1-order W4 rollback\n[\s\S]*?```\n/, '');
  refusal(fixture('missing.md', missing), 'W3', 'forward', 'missing run order for W4 rollback');
  refusal(fixture('undefined.md', explicit('ai-missing') + block('ai-present')), 'W3', 'forward', 'step referenced but not defined: ai-missing');
  const wrong = positive.replace('"host":"mac"}', '"host":"mac","when":{"line":1,"quote":"wrong quote"}}');
  refusal(fixture('wrong-when.md', wrong), 'W3', 'forward', 'when quote not found at plan line 1');
  const unaccounted = positive + block('ai-unused');
  refusal(fixture('unused.md', unaccounted), 'W3', 'forward', 'defined step not used or excluded: ai-unused');
  // Add one exclusion only, not before every block.
  const included = unaccounted.replace('## Blocks', 'not-run: {"id":"ai-unused","reason":"helper"}\n## Blocks');
  assert.equal(run(fixture('excluded.md', included)).status, 0);
  const duplicate = positive + block('ai-present');
  const definitions = [...duplicate.matchAll(/^# step: ai-present$/gm)].map(m => duplicate.slice(0, m.index).split('\n').length);
  refusal(fixture('duplicate.md', duplicate), 'W3', 'forward', `duplicate step definition ai-present at plan lines ${definitions.join(' and ')}`);
  refusal(fixture('two-orders.md', positive.replace('## Blocks', '```c1-order W3 forward\n{"id":"ai-present","host":"mac"}\n```\n## Blocks')), 'W3', 'forward', 'duplicate run order for W3 forward');
  refusal(fixture('no-section.md', block('ai-present')), 'W3', 'forward', 'expected one Run orders section');
  refusal(control, 'W0', 'forward', 'unknown window W0');
  refusal(control, 'W3', 'retry', 'unknown mode retry');
  refusal(fixture('invalid-utf8.md', Buffer.from([0xff])), 'W3', 'forward', 'plan is not valid UTF-8');
  const marker = positive.replace('# readonly: yes\n', '');
  const line = marker.slice(0, marker.indexOf('# step:')).split('\n').length;
  refusal(fixture('missing-marker.md', marker), 'W3', 'forward', `step ai-present missing host or readonly marker at plan line ${line}`);
  // Legacy table cannot override explicit orders inside the canonical section.
  const legacy = positive.replace('\n\n```c1-order', '\n| Window | Mode | Steps |\n| W3 | forward | ai-ignored |\n\n```c1-order');
  refusal(fixture('legacy.md', legacy), 'W3', 'forward', 'unrecognised run-order line at plan line 2');
  const unknown = positive.replace('{"id":"ai-present","host":"mac"}', '{"id":"ai-present","host":"mac","typo":true}');
  refusal(fixture('unknown.md', unknown), 'W3', 'forward', 'unknown order key typo');
  const prose = positive.replace('\n\n```c1-order', '\nunrecognised instruction\n\n```c1-order');
  refusal(fixture('prose.md', prose), 'W3', 'forward', 'unrecognised run-order line at plan line 2');
});

// Independent call-graph check: fixtures that replace ai_run cannot detect a missing dispatcher entry.
test('box ai_run allowlist covers every literal nested box dispatch', () => {
  let source = text;
  if (process.env.C1_ALLOWLIST_PLAN_REF) {
    const ref = process.env.C1_ALLOWLIST_PLAN_REF;
    const present = spawnSync('git', ['cat-file', '-e', `${ref}^{commit}`]);
    assert.equal(present.status, 0, `allowlist control commit ${ref} is absent: fetch it with fetch-depth: 0`);
    const old = spawnSync('git', ['show', `${ref}:docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md`], { encoding: 'utf8' });
    assert.equal(old.status, 0, old.stderr); source = old.stdout;
  }
  const bodies = [...source.matchAll(/^```sh\n([\s\S]*?)^```[ \t]*$/gm)].map(m => m[1]!);
  const dispatcher = bodies.find(b => b.includes('ai_run() {'))!;
  assert.ok(dispatcher, 'box dispatcher exists');
  const arm = /case "\$STEP_NAME" in ([^\n]+?)\) ;;/m.exec(dispatcher);
  assert.ok(arm, 'dispatcher has one step allowlist');
  const allowed = new Set(arm[1]!.split('|'));
  const macOnly = new Map<string, string>(); // No box caller may dispatch a Mac-only step today.
  const calls = new Map<string, string[]>();
  for (const body of bodies) {
    if (!/^# host: .*box/im.test(body)) continue;
    const caller = /^# step: (\S+)/m.exec(body)![1]!;
    for (const m of body.split('\n').filter(line => !/^\s*#/.test(line)).join('\n').matchAll(/\bai_run\s+(ai-[a-z0-9-]+)/g)) calls.set(m[1]!, [...(calls.get(m[1]!) ?? []), caller]);
  }
  assert.ok(calls.size > 0, 'enumerated box calls');
  for (const [step, callers] of calls) assert.ok(allowed.has(step) || macOnly.has(step), `box ai_run allowlist missing ${step}; callers: ${[...new Set(callers)].join(', ')}`);
});

test('resolved run orders keep opening, recovery and concurrent audit dispatch conditions', () => {
  const task = (window: string, mode = 'forward') => {
    const result = run(planPath, window, mode); assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as Task;
  };
  for (const window of ['W3', 'W4', 'W6', 'W7']) {
    const steps = task(window).steps;
    const open = steps.findIndex(s => s.id === 'ai-open');
    assert.ok(open >= 0);
    assert.ok(steps.every((s, i) => s.id !== 'ai-live-controls' || i > open), `${window}: live controls require open proof paths`);
  }
  const w4 = task('W4', 'recovered-close').steps;
  assert.ok(!w4.some(s => s.id === 'ai-emergency-close'));
  assert.ok(w4.findIndex(s => s.id === 'ai-w4-rollback') < w4.findIndex(s => s.id === 'ai-close'));
  const w5 = task('W5', 'recovered-close').steps;
  assert.ok(!w5.some(s => s.id === 'ai-w5-closed'));
  assert.ok(w5.findIndex(s => s.id === 'ai-w5-recovery-transfer') < w5.findIndex(s => s.id === 'ai-w5-recovery-env'));
  assert.ok(w5.findIndex(s => s.id === 'ai-w5-recovery-env') < w5.findIndex(s => s.id === 'ai-close'));
  assert.ok(!w5.some(s => s.id === 'ai-open' || s.id === 'ai-db-session'));
  const w6 = task('W6').steps;
  assert.ok(!w6.some(s => s.id === 'ai-w6-audit-watch'));
  assert.ok(!w6.some(s => s.id === 'ai-w6-audit'), 'audit is never an executable order step');
  const driver = w6.find(s => s.id === 'ai-w6-fence-driver')!;
  const audit = driver.dispatched_blocks!.find(s => s.id === 'ai-w6-audit')!;
  assert.ok(audit);
  const json = JSON.stringify(task('W6'));
  assert.equal(json.split(JSON.stringify(audit.block).slice(1,-1)).length - 1, 1, 'audit block bytes occur once, attached to its dispatcher');
  const companion = readFileSync('docs/evidence/2026-10-02-site-release/SITE-RELEASE.md', 'utf8');
  for (const step of w5) assert.equal(step.conditions.length, 1, step.id || 'manual');
  for (const step of w5.filter(s => s.id === 'ai-w5-reference')) {
    for (const row of step.conditions[0]!.quote.split('\n')) assert.ok(companion.includes(row), row);
  }
  assert.ok(w6.findIndex(s => s.id === 'ai-w6-fence-driver') < w6.findIndex(s => s.input?.startsWith('C1_CLIENT_ACTION=withdraw')));
  const recovered = task('W6', 'recovered-close').steps;
  assert.ok(recovered.findIndex(s => s.id === 'ai-w6-close-state') < recovered.findIndex(s => s.id === 'ai-close'));
});

test('W1/W2/W2b orders preserve additive recovery, the W2 fence and the W2b admission condition', () => {
  const task = (window: string, mode: string) => {
    const result = run(planPath, window, mode); assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as Task;
  };
  for (const w of ['W1','W2','W2b']) assert.ok(task(w,'forward').steps.every(s => !s.id?.startsWith('ai-w3-')), w);
  const w1 = task('W1', 'forward').steps;
  assert.ok(w1.findIndex(s => s.id === 'ai-open') < w1.findIndex(s => s.id === 'ai-w1-backup-gate'));
  assert.ok(w1.findIndex(s => s.id === 'ai-w1-backup-gate') < w1.findIndex(s => s.id === 'ai-close'));
  const forward = task('W2', 'forward').steps;
  const ids = forward.map(s => s.id);
  for (const [before, after] of [['ai-db-session','ai-w2-stage-probes'], ['ai-w2-stage-probes','ai-w2-preflight'],
    ['ai-w2-preflight','ai-w2-apply'], ['ai-w2-apply','ai-w2-reconcile'],
    ['ai-w2-reconcile','ai-w2-probes'], ['ai-w2-probes','ai-w2-issuer-credential']]) {
    assert.ok(ids.indexOf(before!) >= 0 && ids.indexOf(before!) < ids.indexOf(after!), `${before} before ${after}`);
  }
  assert.match(forward.find(s => s.id === 'ai-w2-apply')!.conditions[0]!.quote, />= 600 s/);
  for (const mode of ['rollback','recovered-close']) {
    const steps = task('W2', mode).steps;
    assert.equal(steps[0]!.manual!.quote, 'Failure: STOP, reconcile the committed prefix, retain it; no retry or automatic reserve.');
    assert.ok(steps.some(s => s.id === 'ai-w2-reconcile' && s.input?.includes('do not continue this order')));
    assert.ok(steps.every(s => !s.id || !['ai-open','ai-w2-apply','ai-w2-preflight'].includes(s.id)));
    assert.ok(steps.some(s => s.manual?.quote.includes('production schema rollback is authorized')));
    assert.equal(steps.some(s => s.id === 'ai-close'), mode === 'recovered-close');
  }
  assert.ok(task('W2', 'rollback').steps.some(s => s.id === 'ai-w2-issuer-rollback'));
  assert.ok(task('W2b', 'rollback').steps.some(s => s.id === 'ai-w2-issuer-rollback'));
  for (const window of ['W2', 'W2b'] as const) {
    const recovered = task(window, 'recovered-close').steps;
    const rollback = recovered.find(s => s.id === 'ai-w2-issuer-rollback');
    assert.ok(rollback, `${window} recovered-close must dispatch ai-w2-issuer-rollback`);
    assert.equal(rollback!.manual, undefined, `${window} recovered-close rollback is a step, not a manual`);
    assert.ok(rollback!.conditions.some(c => c.quote.includes('Ownership marker BEFORE any mutation')), `${window} recovered-close rollback carries the marker condition`);
    assert.ok(recovered.findIndex(s => s.id === 'ai-w2-issuer-rollback') < recovered.findIndex(s => s.id === 'ai-close'), `${window}: rollback before close`);
  }
  assert.equal(task('W2', 'forward').steps.length, 21);
  assert.equal(task('W2', 'recovered-close').steps.length, 13);
  assert.equal(task('W2b', 'recovered-close').steps.length, 11);
  for (const mode of modes) {
    const steps = task('W2b', mode).steps;
    assert.equal(steps[0]!.conditions[0]!.quote, 'Only when W2 committed and reconciled all five migrations but its issuer credential failed and was rolled back.');
    assert.ok(steps.every(s => !s.id?.startsWith('ai-w2-stage') && !s.id?.startsWith('ai-w2-backfill') && s.id !== 'ai-w2-apply'));
  }
  const w2b = task('W2b', 'forward').steps.map(s => s.id);
  assert.ok(w2b.indexOf('ai-w2-issuer-credential') < w2b.indexOf('ai-w2b-forward-catalogs'));
  const w7f = task('W7', 'forward').steps;
  assert.ok(w7f.findIndex(s => s.id === 'ai-gates') >= 0, 'Mac still runs ai-gates');
  assert.ok(w7f.findIndex(s => s.id === 'ai-w7-timer-hold') < w7f.findIndex(s => s.id === 'ai-w7-proof'));
  assert.ok(w7f.findIndex(s => s.id === 'ai-w7-timer-hold') < w7f.findIndex(s => s.id === 'ai-close'));
  for (const mode of ['rollback', 'recovered-close']) {
    const steps = task('W7', mode).steps;
    assert.ok(steps.some(s => s.id === 'ai-w7-recovery'), mode);
    assert.ok(!steps.some(s => s.id === 'ai-emergency-close'), mode);
    assert.ok(!steps.some(s => s.id === 'ai-w6-activation-rollback'), mode);
  }
  assert.equal(task('W5', 'recovered-close').steps.length, 10);
  assert.equal(task('W7', 'forward').steps.length, 22);
  assert.equal(task('W7', 'rollback').steps.length, 2);
  assert.equal(task('W7', 'recovered-close').steps.length, 10);
});

test('C1-12 W5 recovered-close generated task under bash -u reaches ai-close with recovery-env variables set', () => {
  const generated = run(planPath, 'W5', 'recovered-close');
  assert.equal(generated.status, 0, generated.stderr);
  const task: Task = JSON.parse(generated.stdout);
  const envStep = task.steps.find(s => s.id === 'ai-w5-recovery-env')!;
  const closeIdx = task.steps.findIndex(s => s.id === 'ai-close');
  assert.ok(envStep && closeIdx > task.steps.indexOf(envStep));
  const frozen = spawnSync('git', ['show', '86673f1f:docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'], { encoding: 'utf8' });
  assert.equal(frozen.status, 0, frozen.stderr);
  const frozenRecovered = frozen.stdout.match(/```c1-order W5 recovered-close\n([\s\S]*?)```/)![1]!;
  assert.doesNotMatch(frozenRecovered, /ai-w5-recovery-env/);
  assert.match(frozenRecovered, /"id":"ai-close"/);
  const dir = mkdtempSync(join(scratch, 'w5env-'));
  const sha = 'a'.repeat(40), wid = 'Ab12Cd';
  const proof = join(dir, 'home/commonswarm/admin-issuance/release-proofs', `${sha}-W5-${wid}`);
  mkdirSync(proof, { recursive: true, mode: 0o700 });
  chmodSync(proof, 0o700);
  const planSrc = join(dir, 'RELEASE.src.md');
  writeFileSync(planSrc, '# reviewed plan\n');
  const archive = join(proof, 'release.tar');
  const tar = spawnSync('python3', ['-c', 'import sys,tarfile\nwith tarfile.open(sys.argv[1],"w") as t:\n t.add(sys.argv[2],arcname="docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md")', archive, planSrc], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const archiveDigest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const planDigest = createHash('sha256').update(readFileSync(planSrc)).digest('hex');
  const inputs = { window: 'W5', release_sha: sha, window_id: wid, archive_sha256: archiveDigest, plan_sha256: planDigest };
  const operatorInputs = join(dir, 'inputs.json');
  writeFileSync(operatorInputs, JSON.stringify(inputs));
  writeFileSync(join(proof, 'inputs.json'), JSON.stringify(inputs));
  mkdirSync(join(proof, 'site-recovery'), { mode: 0o700 });
  const closeStub = `reached_ai_close() {
  : "\${WINDOW:?}" "\${WINDOW_ID:?}" "\${RELEASE_SHA:?}" "\${PROOF_DIR:?}" "\${INPUTS_FILE:?}" "\${BOX_ARCHIVE_PATH:?}" "\${SITE_RECOVERY_EVIDENCE:?}" "\${PLAN_FILE:?}" "\${CLOSE_RESULT:?}"
  printf 'REACHED ai-close WINDOW=%s PROOF_DIR=%s INPUTS_FILE=%s BOX_ARCHIVE_PATH=%s SITE_RECOVERY_EVIDENCE=%s PLAN_FILE=%s CLOSE_RESULT=%s\\n' \\
    "$WINDOW" "$PROOF_DIR" "$INPUTS_FILE" "$BOX_ARCHIVE_PATH" "$SITE_RECOVERY_EVIDENCE" "$PLAN_FILE" "$CLOSE_RESULT"
}
`;
  const body = envStep.block.split('/home/commonswarm/admin-issuance').join(join(dir, 'home/commonswarm/admin-issuance')) + '\nreached_ai_close\n';
  const env: NodeJS.ProcessEnv = { ...process.env, INPUTS_FILE: operatorInputs };
  for (const key of ['WINDOW', 'WINDOW_ID', 'RELEASE_SHA', 'PROOF_DIR', 'BOX_ARCHIVE_PATH', 'SITE_RECOVERY_EVIDENCE', 'PLAN_FILE', 'CLOSE_RESULT']) delete env[key];
  const r = spawnSync('/bin/bash', ['-u'], { input: closeStub + body, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /REACHED ai-close WINDOW=W5/);
  assert.match(r.stdout, new RegExp(`PROOF_DIR=${proof.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(r.stdout, /CLOSE_RESULT=recovered/);
});

test('C1-18: run-order manuals never quote a FAIL line or name a defined ai- step to Run', () => {
  const defined = new Set([...text.matchAll(/^# step: (ai-[a-z0-9-]+)$/gm)].map(m => m[1]!));
  const section = /## Run orders \(machine-read by scripts\/c1-task-from-plan\.mjs\)\n([\s\S]*?)\n## /.exec(text)![1]!;
  const manuals: { line: number; quote: string; input?: string }[] = [];
  for (const raw of section.split('\n')) {
    if (!raw.startsWith('{') || !raw.includes('"manual"')) continue;
    const row = JSON.parse(raw) as { manual?: { quote: string }; input?: string };
    if (!row.manual) continue;
    manuals.push({ line: 0, quote: row.manual.quote, input: row.input });
  }
  assert.ok(manuals.length > 0, 'plan has manual rows');
  for (const row of manuals) {
    assert.doesNotMatch(row.quote, /\bFAIL /, `manual quotes FAIL text: ${row.quote.slice(0, 80)}`);
    const named = row.input?.match(/\bRun (ai-[a-z0-9-]+)/)?.[1];
    assert.ok(!named || !defined.has(named), `manual names defined step ${named} as something to Run`);
  }
  const positive = explicit('ai-present') + block('ai-present');
  const failManual = 'FAIL ai-present: synthetic\n' + positive.replaceAll('{"id":"ai-present","host":"mac"}',
    '{"host":"box","manual":{"line":1,"quote":"FAIL ai-present: synthetic"},"input":"acknowledge the refusal"}');
  refusal(fixture('fail-manual.md', failManual), 'W3', 'forward', 'manual quote is a FAIL line at plan line 5');
  const runManual = 'Ownership marker BEFORE any mutation\n' + positive.replaceAll('{"id":"ai-present","host":"mac"}',
    '{"host":"box","manual":{"line":1,"quote":"Ownership marker BEFORE any mutation"},"input":"Run ai-present only when a marker exists"}');
  refusal(fixture('run-manual.md', runManual), 'W3', 'forward', 'manual names defined step ai-present as something to Run at plan line 5');
});

test('C1-20: recovered-close lost-shell ai-db-session has ai-recovery-env immediately before it', () => {
  const task = (window: string) => {
    const result = run(planPath, window, 'recovered-close');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as Task;
  };
  const lost = ['W1', 'W2', 'W2b', 'W3', 'W4', 'W6', 'W6e', 'W7'];
  for (const window of lost) {
    const steps = task(window).steps;
    const session = steps.findIndex(s => s.id === 'ai-db-session' && s.input?.includes('Only if original box shell was lost'));
    assert.ok(session > 0, window);
    assert.equal(steps[session - 1]!.id, 'ai-recovery-env', window);
    assert.match(steps[session - 1]!.input ?? '', /Only if original box shell was lost/);
    const macClose = steps.findIndex(s => s.id === 'ai-mac-close');
    assert.equal(steps[macClose - 1]!.id, 'ai-mac-recovery-env', window);
    assert.match(steps[macClose - 1]!.input ?? '', /Only if original Mac shell was lost/);
  }
  const w5 = task('W5').steps;
  assert.ok(!w5.some(s => s.id === 'ai-recovery-env' || s.id === 'ai-db-session'));
  assert.ok(w5.some(s => s.id === 'ai-w5-recovery-env'));
  const frozenPresent = spawnSync('git', ['cat-file', '-e', 'cd46463c^{commit}']);
  assert.equal(frozenPresent.status, 0, 'baseline commit cd46463c is absent from this clone: fetch it (fetch-depth: 0 or git fetch origin cd46463c)');
  const frozen = spawnSync('git', ['show', 'cd46463c:docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md'], { encoding: 'utf8' });
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.doesNotMatch(frozen.stdout, /# step: ai-recovery-env/);
  assert.doesNotMatch(frozen.stdout, /# step: ai-mac-recovery-env/);
  const frozenW2 = frozen.stdout.match(/```c1-order W2 recovered-close\n([\s\S]*?)```/)![1]!;
  assert.doesNotMatch(frozenW2, /ai-recovery-env/);
  assert.match(frozenW2, /"id":"ai-db-session"/);
});

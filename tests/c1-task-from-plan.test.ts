/** Generator contract at its CLI boundary; no plan block is executed. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
    host: string; readonly: string; block: string; conditions: Passage[]; execution_host: string; input?: string; manual?: Passage; ambiguity?: string; readings?: { source: Passage; steps: Task["steps"] }[] }[];
};
const run = (path: string, window = 'W3', mode = 'forward', output?: string) =>
  spawnSync(process.execPath, [generator, path, window, mode, ...(output ? [output] : [])], { encoding: 'utf8', timeout: 10_000 });
const fixture = (name: string, value: string | Buffer) => {
  const path = join(scratch, name); writeFileSync(path, value); return path;
};
const block = (id: string, command = 'printf hello\n') =>
  `\n\n\`\`\`sh\n# step: ${id}\n# readonly: yes\n# host: Mac\n${command}\`\`\`\n`;
const windows = ['W3', 'W4', 'W5', 'W6', 'W6e', 'W7'];
const modes = ['forward', 'rollback', 'recovered-close'];
const explicit = (steps: string) => {
  const ids = steps.split(' → ');
  const lines = ids.map(id => JSON.stringify({ id, host: 'mac' })).join('\n');
  return '## Run orders (machine-read by scripts/c1-task-from-plan.mjs)\n\n' +
    windows.flatMap(w => modes.map(m => `\`\`\`c1-order ${w} ${m}\n${lines}\n\`\`\`\n`)).join('\n');
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
    if (step.manual) { quote(step.manual); continue; }
    assert.deepEqual(Buffer.from(step.block), bytes.subarray(step.offset, step.offset + step.length));
    assert.equal(bytes.subarray(0, step.offset).toString('utf8').split('\n').length, step.start_line);
    assert.equal(step.block, lines.slice(step.start_line - 1, step.end_line).join('\n') + '\n');
    assert.ok(step.block.startsWith(`# step: ${step.id}\n`));
    assert.ok(step.block.split('\n').includes(step.host));
    assert.ok(step.block.split('\n').includes(step.readonly));
    for (const condition of step.conditions) quote(condition);
  } };
  visit(task.steps);
}

test('real plan: every one of 18 window/mode tasks retains exact blocks, manual text and conditions at their offsets', () => {
  const defined = new Set([...text.matchAll(/^# step: (ai-[a-z0-9-]+)$/gm)].map(m => m[1]));
  const used = new Set<string>();
  const visit = (steps: Task['steps']) => {
    for (const step of steps) {
      if (step.id) { assert.ok(defined.has(step.id)); used.add(step.id); }
      for (const r of step.readings ?? []) visit(r.steps);
    }
  };
  for (const window of windows) for (const mode of modes) {
    const result = run(planPath, window, mode);
    assert.equal(result.status, 0, `${window} ${mode}: ${result.stderr}`);
    const task: Task = JSON.parse(result.stdout);
    verify(task, plan, window, mode); visit(task.steps);
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

test('W5 pins companion bytes and enumerates its normal route without choosing the unresolved first-step conflict', () => {
  const result = run(planPath, 'W5', 'forward');
  assert.equal(result.status, 0, result.stderr);
  const task = JSON.parse(result.stdout);
  const site = readFileSync('docs/evidence/2026-10-02-site-release/SITE-RELEASE.md');
  assert.equal(task.header.site_plan.sha256, createHash('sha256').update(site).digest('hex'));
  assert.equal(task.header.requires_lead_ruling, true);
  const contract = JSON.parse(/```release-contract\n([\s\S]*?)\n```/.exec(site.toString())![1]!);
  const first = task.steps.find((s: any) => s.ambiguity === 'site-first');
  const selected = [...first.readings[0].steps, ...task.steps.filter((s: any) => s.id === 'ai-w5-reference')];
  assert.deepEqual(selected.map(s => s.input.split(';')[0].replace('SITE_STEP=', '')), contract.routes.normal);
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
  const included = unaccounted.replace('\n\n```sh', '\nnot-run: {"id":"ai-unused","reason":"helper"}\n\n```sh');
  assert.equal(run(fixture('excluded.md', included)).status, 0);
  const duplicate = positive + block('ai-present');
  const definitions = [...duplicate.matchAll(/^# step: ai-present$/gm)].map(m => duplicate.slice(0, m.index).split('\n').length);
  refusal(fixture('duplicate.md', duplicate), 'W3', 'forward', `duplicate step definition ai-present at plan lines ${definitions.join(' and ')}`);
  refusal(fixture('two-orders.md', positive.replace('\n\n```sh', '\n```c1-order W3 forward\n{"id":"ai-present","host":"mac"}\n```\n\n```sh')), 'W3', 'forward', 'duplicate run order for W3 forward');
  refusal(fixture('no-section.md', block('ai-present')), 'W3', 'forward', 'expected one Run orders section');
  refusal(control, 'W0', 'forward', 'unknown window W0');
  refusal(control, 'W3', 'retry', 'unknown mode retry');
  refusal(fixture('invalid-utf8.md', Buffer.from([0xff])), 'W3', 'forward', 'plan is not valid UTF-8');
  const marker = positive.replace('# readonly: yes\n', '');
  const line = marker.slice(0, marker.indexOf('# step:')).split('\n').length;
  refusal(fixture('missing-marker.md', marker), 'W3', 'forward', `step ai-present missing host or readonly marker at plan line ${line}`);
  // Legacy table cannot override explicit orders inside the canonical section.
  const legacy = '| Window | Mode | Steps |\n| W3 | forward | ai-ignored |\n' + positive;
  assert.equal(run(fixture('legacy.md', legacy)).status, 0);
});

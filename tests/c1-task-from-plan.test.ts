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
    host: string; readonly: string; block: string; conditions: Passage[] }[];
};
const run = (path: string, window = 'W3', mode = 'forward', output?: string) =>
  spawnSync(process.execPath, [generator, path, window, mode, ...(output ? [output] : [])], { encoding: 'utf8', timeout: 10_000 });
const fixture = (name: string, value: string | Buffer) => {
  const path = join(scratch, name); writeFileSync(path, value); return path;
};
const block = (id: string, command = 'printf hello\n') =>
  `\n\n\`\`\`sh\n# step: ${id}\n# readonly: yes\n# host: Mac\n${command}\`\`\`\n`;
const explicit = (steps: string) => `| Window | Mode | Steps |\n| --- | --- | --- |\n| W3 | forward | ${steps} |\n`;
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
  const quote = (p: Passage) => assert.equal(p.quote, lines.slice(p.start_line - 1, p.end_line).join('\n'));
  for (const evidence of task.order_evidence) quote(evidence);
  for (const step of task.steps) {
    assert.deepEqual(Buffer.from(step.block), bytes.subarray(step.offset, step.offset + step.length));
    assert.equal(bytes.subarray(0, step.offset).toString('utf8').split('\n').length, step.start_line);
    assert.equal(step.block, lines.slice(step.start_line - 1, step.end_line).join('\n') + '\n');
    assert.ok(step.block.startsWith(`# step: ${step.id}\n`));
    assert.ok(step.block.split('\n').includes(step.host));
    assert.ok(step.block.split('\n').includes(step.readonly));
    for (const condition of step.conditions) quote(condition);
  }
}

test('real plan: all 27 window/mode pairs either round-trip or name the unresolved order exactly', () => {
  const windows = ['W3', 'W4', 'W5', 'W6', 'W7', 'W6e', 'ai-close', 'ai-open-abort', 'ai-mac-close'];
  const modes = ['forward', 'rollback', 'recovered-close'];
  let generated = 0, refused = 0;
  for (const window of windows) for (const mode of modes) {
    const result = run(planPath, window, mode);
    const row = text.split('\n').findIndex(line => line.startsWith(`| ${window} `)) + 1;
    if (window.startsWith('ai-') || (['W3', 'W4'].includes(window) && mode === 'rollback')) {
      assert.equal(result.status, 0, result.stderr);
      verify(JSON.parse(result.stdout), plan, window, mode); generated++;
    } else {
      const reason = !row ? 'no window order row' : mode === 'rollback' ? 'no explicit whole-block rollback order'
        : mode === 'recovered-close' ? 'no window-specific recovered-close order (phase and recovery prerequisites are prose)'
        : window === 'W5' ? 'referenced site plan order and repeated SITE_STEP inputs are not defined here'
        : 'common preflight/open/session does not name an ordered list of blocks';
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `FAIL c1-task-from-plan: ambiguous order for ${window} ${mode}${row ? ` at plan line ${row}` : ''}: ${reason}; STOP\n`);
      refused++;
    }
  }
  assert.equal(generated, 11);
  assert.equal(refused, 16);
});

test('W3 public-probe condition survives verbatim beside its block when an explicit order is supplied', () => {
  // The real plan has no complete forward order. Supply a synthetic explicit
  // order for the one probe named by its condition; retain the entire real plan
  // and compare output to those plan bytes, without copying a step inventory.
  const condition = /Before W4, the live Caddy[\s\S]*?Baseline route availability is measured, never guessed\./.exec(text)![0];
  const id = /Run public\n(ai-[a-z0-9-]+)/.exec(condition)![1];
  const bytes = Buffer.from(explicit(id) + '\n' + text);
  const path = fixture('explicit-real-probe.md', bytes);
  const result = run(path);
  assert.equal(result.status, 0, result.stderr);
  const task: Task = JSON.parse(result.stdout);
  verify(task, bytes, 'W3', 'forward');
  assert.equal(task.steps.length, 1);
  assert.equal(task.steps[0]!.id, id);
  assert.ok(task.steps[0]!.conditions.some(p => p.quote === condition));
});

test('synthetic order, edited block, file output and UTF-8 offsets are observable at the CLI', () => {
  const before = 'π: generated from plan\n' + explicit('ai-beta → ai-alpha → ai-beta') + block('ai-alpha') + block('ai-beta');
  const path = fixture('positive.md', before);
  const result = run(path);
  assert.equal(result.status, 0, result.stderr);
  const task: Task = JSON.parse(result.stdout);
  verify(task, Buffer.from(before), 'W3', 'forward');
  // Order comes from the table rather than definition order, and repeats stay.
  assert.equal(task.steps.map(s => s.id).join(' → '), /\| W3 \| forward \| (.*?) \|/.exec(before)![1]);
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

test('undefined steps, duplicate definitions, ambiguous orders and invalid inputs refuse exactly', () => {
  const positive = explicit('ai-present') + block('ai-present');
  assert.equal(run(fixture('control.md', positive)).status, 0, 'same-invocation positive control');
  refusal(fixture('undefined.md', explicit('ai-missing') + block('ai-present')), 'W3', 'forward', 'step referenced but not defined: ai-missing');
  const duplicate = positive + block('ai-present');
  const definitions = [...duplicate.matchAll(/^# step: ai-present$/gm)].map(m => duplicate.slice(0, m.index).split('\n').length);
  refusal(fixture('duplicate.md', duplicate), 'W3', 'forward', `duplicate step definition ai-present at plan lines ${definitions.join(' and ')}`);
  refusal(fixture('ambiguous.md', explicit('ai-present or ai-other') + block('ai-present') + block('ai-other')), 'W3', 'forward', 'ambiguous order for W3 forward at plan line 3: order must name steps and separators only');
  refusal(fixture('two-orders.md', explicit('ai-present') + '| W3 | forward | ai-present |\n' + block('ai-present')), 'W3', 'forward', 'ambiguous order for W3 forward at plan line 4: multiple explicit order rows');
  const path = fixture('valid.md', positive);
  refusal(path, 'W0', 'forward', 'unknown window W0');
  refusal(path, 'W3', 'retry', 'unknown mode retry');
  refusal(fixture('invalid-utf8.md', Buffer.from([0xff])), 'W3', 'forward', 'plan is not valid UTF-8');
  refusal(fixture('missing-marker.md', explicit('ai-present') + block('ai-present').replace('# readonly: yes\n', '')), 'W3', 'forward', 'step ai-present missing host or readonly marker at plan line 7');
});

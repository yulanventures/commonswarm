#!/usr/bin/env node
// Emits a JSON task on stdout; an optional fourth argument names a new output file.
// Blocks are data, never executed. Offsets and lengths are UTF-8 byte counts.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';

const VERSION = '5';
const WINDOWS = new Set(['W1', 'W2', 'W2b', 'W3', 'W4', 'W5', 'W6', 'W6e', 'W7']);
const MODES = new Set(['forward', 'rollback', 'recovered-close']);
class PlanError extends Error {}
const fail = (reason) => { throw new PlanError(`FAIL c1-task-from-plan: ${reason}; STOP`); };

function parse(raw) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { fail('plan is not valid UTF-8'); }
  if (!Buffer.from(source).equals(raw)) fail('plan bytes do not round-trip');
  const lines = source.split('\n');
  const lineAt = (offset) => source.slice(0, offset).split('\n').length;
  const blocks = new Map();
  for (const match of source.matchAll(/^```sh\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)) {
    const body = match[1];
    const charOffset = match.index + match[0].indexOf('\n') + 1;
    const startLine = lineAt(charOffset);
    const id = /^# step: (ai-[a-z0-9-]+)\r?\n/.exec(body)?.[1];
    if (!id) continue;
    if (blocks.has(id)) fail(`duplicate step definition ${id} at plan lines ${blocks.get(id).start_line} and ${startLine}`);
    const host = body.match(/^# host: .+$/m)?.[0];
    const readonly = body.match(/^# readonly: (?:yes|no|probe)\r?$/m)?.[0];
    if (!host || !readonly) fail(`step ${id} missing host or readonly marker at plan line ${startLine}`);
    const offset = Buffer.byteLength(source.slice(0, charOffset));
    const bytes = Buffer.from(body);
    if (!raw.subarray(offset, offset + bytes.length).equals(bytes) || raw.indexOf(bytes, offset) !== offset) {
      fail(`block ${id} does not round-trip at byte offset ${offset}`);
    }
    blocks.set(id, { id, offset, length: bytes.length, start_line: startLine,
      end_line: startLine + body.split('\n').length - 2, host, readonly, block: body });
  }
  return { source, blocks };
}

const SECTION = '## Run orders (machine-read by scripts/c1-task-from-plan.mjs)';

function runOrders(plan, path) {
  const { source, blocks } = plan;
  const lines = source.split('\n');
  const starts = lines.flatMap((line, n) => line === SECTION ? [n] : []);
  if (starts.length !== 1) fail('expected one Run orders section');
  const start = starts[0];
  let end = lines.findIndex((line, n) => n > start && /^## /.test(line));
  if (end < 0) end = lines.length;
  const orders = new Map(), used = new Set(), excluded = new Set();
  let pin;
  const json = (value, line) => {
    try { return JSON.parse(value); } catch { fail(`invalid run-order JSON at plan line ${line}`); }
  };
  const keys = (value, allowed, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid ${label}`);
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown ${label} key ${key}`);
  };
  const quote = (value, label) => {
    keys(value, ['line', 'quote'], label);
    if (!value || !Number.isSafeInteger(value.line) || value.line < 1 || value.line > lines.length ||
        typeof value.quote !== 'string' || !value.quote.length) fail(`invalid ${label} quote`);
    const tail = lines.slice(value.line - 1).join('\n');
    const at = tail.indexOf(value.quote);
    if (at < 0 || at >= lines[value.line - 1].length) fail(`${label} quote not found at plan line ${value.line}`);
    return { start_line: value.line, end_line: value.line + value.quote.split('\n').length - 1, quote: value.quote };
  };
  const expand = (row, line) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`invalid order entry at plan line ${line}`);
    const evidence = { start_line: line, end_line: line, quote: lines[line - 1] };
    if (row.ambiguity !== undefined) fail(`unresolved Lead ruling ${row.ambiguity} at plan line ${line}`);
    keys(row, ['id', 'host', 'when', 'input', 'manual', 'dispatches'], 'order');
    if (!['mac', 'box'].includes(row.host)) fail(`invalid order host at plan line ${line}`);
    const conditions = row.when !== undefined ? [quote(row.when, 'when')] : [];
    if (row.input !== undefined && (typeof row.input !== 'string' || !row.input)) fail(`invalid input note at plan line ${line}`);
    if (row.manual) {
      if (row.id || row.dispatches) fail(`manual entry also names a block at plan line ${line}`);
      const manual = quote(row.manual, 'manual');
      if (/\bFAIL /.test(manual.quote)) fail(`manual quote is a FAIL line at plan line ${line}`);
      const named = typeof row.input === 'string' ? /\bRun (ai-[a-z0-9-]+)/.exec(row.input)?.[1] : undefined;
      if (named && blocks.has(named)) fail(`manual names defined step ${named} as something to Run at plan line ${line}`);
      return { host: row.host, manual, conditions, input: row.input, order_evidence: evidence };
    }
    const block = blocks.get(row.id);
    if (!block) fail(`step referenced but not defined: ${row.id}`);
    used.add(row.id);
    const marker = block.host.slice('# host: '.length).toLowerCase();
    if (!(row.host === 'mac' ? marker.includes('mac') : /box|^he[z]?lead box/.test(marker))) {
      fail(`order host ${row.host} conflicts with step ${row.id} at plan line ${line}`);
    }
    let dispatched_blocks;
    if (row.dispatches !== undefined) {
      if (!Array.isArray(row.dispatches) || !row.dispatches.length || new Set(row.dispatches).size !== row.dispatches.length) fail(`invalid dispatches at plan line ${line}`);
      dispatched_blocks = row.dispatches.map(id => {
        const dependency = blocks.get(id);
        if (!dependency || !block.block.includes(`ai_run ${id}`)) fail(`dispatch ${id} not defined or dispatched by ${row.id}`);
        used.add(id);
        return { ...dependency, dispatched_by: row.id, conditions: [] };
      });
    }
    return { ...block, execution_host: row.host, conditions, input: row.input, order_evidence: evidence, dispatched_blocks };
  };
  for (let n = start + 1; n < end; n++) {
    const line = lines[n];
    if (line.startsWith('site-plan: ')) {
      if (pin) fail('duplicate site plan pin');
      pin = json(line.slice(11), n + 1);
      keys(pin, ['path', 'sha256'], 'site-plan');
      if (!pin || pin.path !== 'docs/evidence/2026-10-02-site-release/SITE-RELEASE.md' || !/^[a-f0-9]{64}$/.test(pin.sha256 ?? '')) fail('invalid site plan pin');
    } else if (line.startsWith('not-run: ')) {
      const entry = json(line.slice(9), n + 1);
      keys(entry, ['id', 'reason'], 'not-run');
      if (!blocks.has(entry.id)) fail(`step referenced but not defined: ${entry.id}`);
      if (excluded.has(entry.id)) fail(`duplicate not-run entry ${entry.id}`);
      if (typeof entry.reason !== 'string' || !entry.reason) fail(`missing not-run reason ${entry.id}`);
      excluded.add(entry.id);
    } else if (line.startsWith('```c1-order')) {
      const match = /^```c1-order (\S+) (\S+)$/.exec(line);
      if (!match || !WINDOWS.has(match[1]) || !MODES.has(match[2])) fail(`invalid order header at plan line ${n + 1}`);
      const key = `${match[1]} ${match[2]}`;
      if (orders.has(key)) fail(`duplicate run order for ${key}`);
      const evidence = [{ start_line: n + 1, end_line: n + 1, quote: line }], steps = [];
      while (++n < end && lines[n] !== '```') {
        if (!lines[n].trim()) fail(`empty order entry at plan line ${n + 1}`);
        steps.push(expand(json(lines[n], n + 1), n + 1));
        evidence.push({ start_line: n + 1, end_line: n + 1, quote: lines[n] });
      }
      if (n === end) fail(`unclosed run order for ${key}`);
      if (!steps.length) fail(`empty run order for ${key}`);
      orders.set(key, { steps, evidence });
    } else if (line.trim()) fail(`unrecognised run-order line at plan line ${n + 1}`);
  }
  for (const window of WINDOWS) for (const mode of MODES) {
    if (!orders.has(`${window} ${mode}`)) fail(`missing run order for ${window} ${mode}`);
  }
  for (const id of blocks.keys()) {
    if (!used.has(id) && !excluded.has(id)) fail(`defined step not used or excluded: ${id}`);
    if (used.has(id) && excluded.has(id)) fail(`step both used and excluded: ${id}`);
  }
  // Literal ai_run dependencies must exist too. Helpers remain with their callers.
  for (const block of blocks.values()) {
    for (const m of block.block.matchAll(/\bai_run\s+(ai-[a-z0-9-]+)/g)) {
      if (!blocks.has(m[1])) fail(`step referenced but not defined: ${m[1]}`);
    }
  }
  if (used.has('ai-w5-reference') && !pin) fail('missing site plan F pin');
  if (pin) {
    // Resolve the pinned repository-relative path from the release plan's repo root.
    const suffix = '/docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md';
    const absolute = resolve(path);
    if (!absolute.endsWith(suffix)) fail('site plan pin requires repository release plan path');
    const bytes = readFileSync(resolve(absolute.slice(0, -suffix.length), pin.path));
    if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) fail('site plan sha256 differs from F pin');
  }
  return { orders, pin };
}

function main() {
  const [path, window, mode, output, ...extra] = process.argv.slice(2);
  if (!path || !window || !mode || extra.length) fail('usage: node scripts/c1-task-from-plan.mjs PLAN WINDOW MODE [OUTPUT]');
  if (!WINDOWS.has(window)) fail(`unknown window ${window}`);
  if (!MODES.has(mode)) fail(`unknown mode ${mode}`);
  const raw = readFileSync(path);
  const plan = parse(raw);
  const { orders, pin } = runOrders(plan, path);
  const sequence = orders.get(`${window} ${mode}`);
  const steps = sequence.steps;
  const task = { header: { plan: resolve(path), plan_sha256: createHash('sha256').update(raw).digest('hex'),
    window, mode, generator_version: VERSION, requires_lead_ruling: steps.some(s => s.requires_lead_ruling), site_plan: pin }, order_evidence: sequence.evidence, steps };
  const serialized = JSON.stringify(task, null, 2) + '\n';
  if (output) writeFileSync(output, serialized, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(serialized);
}

try { main(); }
catch (error) {
  // Raw filesystem diagnostics may include unrelated paths. Report only codes.
  process.stderr.write((error instanceof PlanError ? error.message : `FAIL c1-task-from-plan: I/O failure ${error.code ?? 'unknown'}; STOP`) + '\n');
  process.exitCode = 1;
}

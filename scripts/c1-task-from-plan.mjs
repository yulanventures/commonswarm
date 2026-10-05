#!/usr/bin/env node
// Emits a JSON task on stdout; an optional fourth argument names a new output file.
// Blocks are data, never executed. Offsets and lengths are UTF-8 byte counts.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';

const VERSION = '1';
const WINDOWS = new Set(['W3', 'W4', 'W5', 'W6', 'W7', 'W6e', 'ai-close', 'ai-open-abort', 'ai-mac-close']);
const MODES = new Set(['forward', 'rollback', 'recovered-close']);
class PlanError extends Error {}
const fail = (reason) => { throw new PlanError(`FAIL c1-task-from-plan: ${reason}; STOP`); };
const ambiguous = (window, mode, line, reason) => fail(`ambiguous order for ${window} ${mode}${line ? ` at plan line ${line}` : ''}: ${reason}`);

function parse(raw) {
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { fail('plan is not valid UTF-8'); }
  if (!Buffer.from(source).equals(raw)) fail('plan bytes do not round-trip');
  const lines = source.split('\n');
  const lineAt = (offset) => source.slice(0, offset).split('\n').length;
  const blocks = new Map();
  const proseLines = [...lines];
  for (const match of source.matchAll(/^```sh\r?\n([\s\S]*?)^```[ \t]*\r?$/gm)) {
    const body = match[1];
    const charOffset = match.index + match[0].indexOf('\n') + 1;
    const startLine = lineAt(charOffset);
    for (let n = lineAt(match.index) - 1; n < lineAt(match.index + match[0].length); n++) proseLines[n] = '';
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
  // Keep whole narrative paragraphs. Conditions are quoted, not interpreted or
  // rewritten. These are deliberately conservative: extra context is retained.
  const passages = [];
  let start;
  for (let n = 0; n <= proseLines.length; n++) {
    if (n < proseLines.length && proseLines[n].trim()) { start ??= n; continue; }
    if (start !== undefined) {
      passages.push({ start_line: start + 1, end_line: n, quote: lines.slice(start, n).join('\n') });
      start = undefined;
    }
  }
  return { source, blocks, passages, proseLines };
}

function references(text) { return [...text.matchAll(/\bai-[a-z0-9-]+\b/g)].map(m => m[0]); }

function order(plan, window, mode) {
  if (window.startsWith('ai-')) {
    const block = plan.blocks.get(window);
    if (!block) fail(`step referenced but not defined: ${window}`);
    return { ids: [window], evidence: [{ start_line: block.start_line, end_line: block.start_line, quote: `# step: ${window}` }] };
  }

  // An explicit Markdown order table uses Window | Mode | Steps. The Steps
  // cell must contain only IDs separated by commas, semicolons or arrows.
  // Multiple rows for the same pair are a conflict, never concatenated.
  const explicit = [];
  let explicitTable = false;
  const legacy = [];
  for (let n = 0; n < plan.proseLines.length; n++) {
    const line = plan.proseLines[n];
    if (!line.startsWith('|')) { explicitTable = false; continue; }
    const cells = line.split('|').slice(1, -1).map(s => s.trim());
    if (cells[0] === 'Window') { explicitTable = cells[1] === 'Mode' && /^(?:Steps|Order)$/.test(cells[2] ?? ''); continue; }
    if (explicitTable && cells[0] === window && cells[1] === mode) explicit.push({ text: cells[2] ?? '', line: n + 1, quote: line });
    if (!explicitTable && cells[0]?.split(/\s/)[0] === window && cells.length === 2) legacy.push({ text: cells[1], line: n + 1, quote: line });
  }
  if (explicit.length > 1) ambiguous(window, mode, explicit[1].line, 'multiple explicit order rows');
  if (explicit.length === 1) {
    const row = explicit[0];
    const remainder = row.text.replace(/`?ai-[a-z0-9-]+`?/g, '').replace(/[\s,;→>-]/g, '');
    const ids = references(row.text);
    if (remainder || !ids.length) ambiguous(window, mode, row.line, 'order must name steps and separators only');
    return { ids, evidence: [{ start_line: row.line, end_line: row.line, quote: row.quote }] };
  }
  if (legacy.length !== 1) ambiguous(window, mode, legacy[0]?.line, legacy.length ? 'multiple window order rows' : 'no window order row');
  const row = legacy[0];
  if (mode === 'rollback') {
    // The current plan names a whole rollback block in its "On failure" clause.
    // It already owns its internal ai_run calls; do not dispatch them twice.
    const clause = /\bOn failure (ai-[a-z0-9-]+)\./.exec(row.text);
    if (!clause) ambiguous(window, mode, row.line, 'no explicit whole-block rollback order');
    return { ids: [clause[1]], evidence: [{ start_line: row.line, end_line: row.line, quote: row.quote }] };
  }
  if (mode === 'recovered-close') ambiguous(window, mode, row.line, 'no window-specific recovered-close order (phase and recovery prerequisites are prose)');
  if (row.text.includes('common preflight/open/session')) ambiguous(window, mode, row.line, 'common preflight/open/session does not name an ordered list of blocks');
  if (/referenced|generalized site plan/.test(row.text)) ambiguous(window, mode, row.line, 'referenced site plan order and repeated SITE_STEP inputs are not defined here');
  ambiguous(window, mode, row.line, 'window summary is not an explicit whole-block order');
}

function main() {
  const [path, window, mode, output, ...extra] = process.argv.slice(2);
  if (!path || !window || !mode || extra.length) fail('usage: node scripts/c1-task-from-plan.mjs PLAN WINDOW MODE [OUTPUT]');
  if (!WINDOWS.has(window)) fail(`unknown window ${window}`);
  if (!MODES.has(mode)) fail(`unknown mode ${mode}`);
  const raw = readFileSync(path);
  const plan = parse(raw);
  // References in prose and direct ai_run calls are validated before deriving
  // an order, so an undefined step cannot be concealed by another ambiguity.
  const named = references(plan.proseLines.join('\n'));
  for (const block of plan.blocks.values()) {
    named.push(...[...block.block.matchAll(/\bai_run\s+(ai-[a-z0-9-]+)/g)].map(m => m[1]));
  }
  for (const id of named) if (!plan.blocks.has(id)) fail(`step referenced but not defined: ${id}`);
  const sequence = order(plan, window, mode);
  const steps = sequence.ids.map(id => {
    const block = plan.blocks.get(id);
    if (!block) fail(`step referenced but not defined: ${id}`);
    const conditions = plan.passages.filter(p => references(p.quote).includes(id));
    return { ...block, conditions };
  });
  const task = { header: { plan: resolve(path), plan_sha256: createHash('sha256').update(raw).digest('hex'),
    window, mode, generator_version: VERSION }, order_evidence: sequence.evidence, steps };
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

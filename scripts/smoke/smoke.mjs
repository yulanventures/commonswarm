import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';

const IDS = ['A', 'B', 'C', 'D1', 'D2', 'E0', 'E1', 'F'];
const SITE = 'https://commonswarm.com';
const API = 'https://api.commonswarm.com';
const ISSUER = 'https://mcp.commonswarm.com';
const FIXED = 'CommonSwarm smoke test.';
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const sha = v => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
class ProbeFailure extends Error { constructor(kind, code) { super('probe failure'); this.kind = kind; this.code = code; } }
const must = (v, code = 'contract', kind = 'assertion') => { if (!v) throw new ProbeFailure(kind, code); };
const prerequisite = v => must(v, 'dependency', 'prerequisite');
const write = (p, value) => fs.writeFileSync(p, value, { mode: 0o600 });
const hash = b => createHash('sha256').update(b).digest('hex');
const [mode, ...argv] = process.argv.slice(2);
let evidence, liveContext;
function save(r) { r.overall = IDS.every(id => r.checks[id].status === 'PASS') ? 'PASS' : 'FAIL'; write(path.join(evidence, 'result.json'), JSON.stringify(r)); }
function loadReport() { return JSON.parse(fs.readFileSync(path.join(evidence, 'result.json'), 'utf8')); }
function render(r) {
  const lines = ['RESULT', ...['release_kind', 'release_sha', 'release_utc', 'site_sha', 'workflow_ref', 'workflow_sha', 'probe_sha', 'actual_workflow_sha', 'actual_probe_sha', 'run_utc'].map(k => `${k}=${r[k]}`)];
  for (const id of IDS) {
    const c = r.checks[id];
    lines.push(`${id}=${c.status} elapsed_ms=${c.elapsed_ms} reason=${c.reason}`);
  }
  lines.push(`finalized=${r.finalized === true}`, `rotation=${r.rotation || 'none'}`, `fixture_use=${r.fixture_use || 'pending'}`);
  if (r.blocked) lines.push(r.blocked);
  lines.push(`console_error_count=${r.console_errors}`, `pageerror_count=${r.page_errors}`,
    `total_elapsed_ms=${r.total_elapsed_ms}`, `cleanup=${r.cleanup}`, `leftovers=${r.leftovers.join(',') || 'none'}`,
    `overall=${IDS.every(id => r.checks[id].status === 'PASS') ? 'PASS' : 'FAIL'}`,
    `not_verified=${IDS.filter(id => r.checks[id].status !== 'PASS').join(',') || 'none'}`);
  write(path.join(evidence, 'report.md'), lines.join('\n') + '\n');
}

async function main() {
  if (mode === 'init') {
    const [dir, start, kind, releaseSha, utc, siteSha, probeSha, workflowRef, workflowSha, actualProbeSha, actualWorkflowSha] = argv;
    evidence = dir;
    const valid = /^(site|oauth|edge)(,(site|oauth|edge))*$/.test(kind) && sha(releaseSha) && sha(siteSha) &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(utc) && Number.isFinite(Date.parse(utc)) && sha(probeSha) && sha(workflowSha) &&
      /^[A-Za-z0-9._/-]+$/.test(workflowRef || '') && actualProbeSha === probeSha && actualWorkflowSha === workflowSha;
    const r = { release_kind: valid ? kind : 'invalid', release_sha: valid ? releaseSha : 'invalid',
      release_utc: valid ? utc : 'invalid', site_sha: valid ? siteSha : 'invalid', run_utc: new Date(Number(start)).toISOString(),
      workflow_ref: valid ? workflowRef : 'invalid', workflow_sha: valid ? workflowSha : 'invalid', probe_sha: valid ? probeSha : 'invalid',
      actual_workflow_sha: valid ? actualWorkflowSha : 'invalid', actual_probe_sha: valid ? actualProbeSha : 'invalid',
      checks: Object.fromEntries(IDS.map(id => [id, { status: 'FAIL', elapsed_ms: 0, reason: `${id}_prerequisite_setup` }])),
      finalized: false, console_errors: 0, page_errors: 0, cleanup: 'pending', leftovers: [], total_elapsed_ms: 0 };
    save(r); render(r); must(valid, 'invalid_release_inputs'); return;
  }
  if (mode === 'refusal') {
    const [source, target, secretDir] = argv;
    const raw = fs.readFileSync(source, 'utf8').slice(0, 8192);
    // Preserve the known safe-rm refusal wording. Its target is our fixed temp
    // directory, never an object URL. Unknown diagnostic text is fully redacted.
    const safeReasons = ['system root', 'a home directory', 'the home directory', 'an ancestor of the home directory'];
    let quote = '[refusal text redacted: unrecognized guard diagnostic]';
    const safe = raw.match(/^safe-rm: REFUSED to remove '[^'\n]+' \([^\n]*\): it is ([^\n]+)\. Use \/bin\/rm only if a human really means it\.\s*$/);
    if (safe && (safeReasons.includes(safe[1]) || /^a protected folder \(~\/[A-Za-z0-9_.-]+\)$/.test(safe[1]) || /^inside a protected subtree \(~\/[A-Za-z0-9_./-]+\)$/.test(safe[1]))) {
      quote = `safe-rm: REFUSED to remove '[redacted path]' ([redacted path]): it is ${safe[1]}. Use /bin/rm only if a human really means it.`;
    } else {
      for (const reason of ['Permission denied', 'Operation not permitted', 'Read-only file system']) {
        if (raw.includes(reason)) { quote = `rm: [redacted path]: ${reason}`; break; }
      }
    }
    const ephemeral = /^\/tmp\/anvil-secret\.[A-Za-z0-9]+$/.test(secretDir) ? secretDir : '[redacted path]';
    write(target, `BLOCKED by rm guard: "${quote}". To resolve: HezLead must review ${ephemeral} on this ephemeral runner before disposal; do not bypass the guard.\n`);
    return;
  }
  if (mode === 'finalize') {
    const [dir, cleanup, start, refusalFile, rotation, exitCode] = argv; evidence = dir;
    if (!fs.existsSync(path.join(evidence, 'result.json'))) return;
    const r = loadReport(); r.cleanup = cleanup; r.rotation = rotation; r.total_elapsed_ms = Date.now() - Number(start);
    r.finalized = true;
    if (exitCode === '124' || exitCode === '137') {
      for (const id of IDS) if (r.checks[id].reason.endsWith('_prerequisite_setup')) r.checks[id].reason = `${id}_timeout_setup_or_wrapper`;
      if (r.active_check && r.checks[r.active_check].status === 'PASS')
        r.checks[r.active_check] = { ...r.checks[r.active_check], status: 'FAIL', reason: `${r.active_check}_timeout_wrapper` };
      r.checks.F = { ...r.checks.F, status: 'FAIL', reason: 'F_timeout_wrapper' };
    }
    // The ephemeral job container has no durable plaintext retention. Block the fixture whenever
    // refresh completion is uncertain, even if encryption succeeded.
    r.fixture_use = ['none', 'saved'].includes(rotation) ? 'allowed' : 'blocked_until_recovery_or_fresh_grant';
    if (r.fixture_use !== 'allowed' && r.checks.E0.status === 'PASS') r.checks.E0 = { ...r.checks.E0, status: 'FAIL', reason: `E0_rotation_${rotation}` };
    if (cleanup !== 'REMOVED') r.checks.F = { ...r.checks.F, status: 'FAIL', reason: `F_${cleanup.includes('TIMEOUT') ? 'timeout' : 'prerequisite'}_${cleanup.toLowerCase()}` };
    if (cleanup === 'DELETE_REFUSED' || cleanup === 'PATH_REFUSED') r.leftovers.push('ephemeral-secret-directory-until-runner-disposal');
    if (refusalFile && fs.existsSync(refusalFile)) r.blocked = fs.readFileSync(refusalFile, 'utf8').trim();
    if (r.total_elapsed_ms > 300_000) r.checks.F = { ...r.checks.F, status: 'FAIL', reason: 'F_timeout_five_minute_deadline' };
    save(r); render(r); return;
  }
  must(mode === 'run');
  const [dir, out, tools, start] = argv; evidence = out;
  const r = loadReport(), t0 = Number(start);
  const secret = name => path.join(dir, name);
  const item = JSON.parse(fs.readFileSync(secret('item.json'), 'utf8'));
  const field = label => { const matches = item.fields.filter(f => f.label === label); must(matches.length === 1); return matches[0]; };
  prerequisite(field('fixture_state').value === 'ready');
  const config = JSON.parse(field('smoke_config').value);
  const cookies = JSON.parse(field('oauth_provider_cookies').value);
  for (const k of ['test_user_id', 'workspace_id', 'baseline_grant_id']) must(uuid(config[k]));
  must(config.test_display_name === 'CommonSwarm Smoke Test' && config.workspace_name === 'CommonSwarm Smoke Test');
  must(config.seat_name === 'cs-smoke' && /^seat_[A-Za-z0-9_-]{22,64}$/.test(config.seat_handle));
  must(['google', 'github'].includes(config.oauth_provider));
  for (const k of ['test_email', 'baseline_client_id', 'oauth_client_id', 'oauth_redirect_uri', 'app_anon_key', 'web_client_version'])
    must(typeof config[k] === 'string' && config[k].length > 0);
  must(config.baseline_client_id !== config.oauth_client_id);
  for (const k of ['oauth_client_id', 'oauth_redirect_uri', 'oauth_return_url']) {
    const u = new URL(config[k]); must(u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search);
  }
  must(new URL(config.oauth_return_url).origin === new URL(config.oauth_redirect_uri).origin);
  must(Array.isArray(config.oauth_provider_cookie_domains) && Array.isArray(config.oauth_network_origins));
  for (const origin of config.oauth_network_origins) {
    const u = new URL(origin); must(u.protocol === 'https:' && u.origin === origin);
  }
  must(Array.isArray(cookies) && cookies.length > 0);
  for (const c of cookies) {
    must(config.oauth_provider_cookie_domains.includes(c.domain));
    must(!c.domain.replace(/^\./, '').endsWith('commonswarm.com'));
  }
  must(config.mailbox?.port === 993 && config.mailbox.host && config.mailbox.username && config.mailbox.password);
  must(config.fixture_site_sha === r.site_sha, 'fixture_release_hooks_not_reviewed');
  const nodeVersion = process.versions.node.split('.').map(Number);
  must(nodeVersion[0] > 22 || (nodeVersion[0] === 22 && nodeVersion[1] >= 12));
  must(Date.now() < t0 + 20_000, 'setup_deadline');
  write(secret('hosted-refresh.txt'), field('hosted_refresh_token').value);
  write(secret('config.json'), JSON.stringify(config)); write(secret('cookies.json'), JSON.stringify(cookies));

  const scope = new AsyncLocalStorage();
  let currentCheck;
  const state = () => { const st = scope.getStore(); prerequisite(st); return st; };
  const alive = st => must(!st.controller.signal.aborted && !st.closed && Date.now() < st.deadline, 'deadline', 'timeout');
  let context, page, browserBroken = false, isolation = false, authenticated = false;
  let fileId, versionId, versionN, uploadUrl, downloadUrl, signalId, appToken, commandHeaders, commandVersion;
  let png, originalAction, originalBody, consentPage, callbackCount = 0;
  const observed = new Map(), stages = {}, putCandidates = new Map();
  let associatedPut, putWireReceipt;
  let sequence = [], mcpBearer, initOk = false, controlIdentity, identityPromise;
  const remaining = max => { const st = state(); alive(st); return Math.max(1, Math.min(max, st.deadline - Date.now())); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, remaining(ms)));
  async function request(url, opts = {}) {
    const u = new URL(url); must([API, SITE, ISSUER].includes(u.origin));
    return fetch(url, { ...opts, redirect: 'error', signal: AbortSignal.any([state().controller.signal, AbortSignal.timeout(remaining(15_000))]) });
  }
  function failureCode(id, err, st) {
    if (Date.now() >= st.deadline || st.controller.signal.aborted || err?.name === 'TimeoutError') return `${id}_timeout_deadline`;
    if (isolation && st.failure) return `${id}_${st.failure.kind}_${st.failure.code}`;
    if (err instanceof ProbeFailure) return `${id}_${err.kind}_${err.code}`;
    return `${id}_assertion_operation`; // Never return dependency exception text.
  }
  async function stopBrowser() {
    browserBroken = true;
    if (context) await Promise.race([context.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);
  }
  async function check(id, offset, task) {
    // The object never changes identity. Every helper/guard continuation retains it.
    const st = { id, deadline: Math.min(t0 + offset, t0 + 280_000), controller: new AbortController(), closed: false, work: new Set() };
    currentCheck = st; r.active_check = id; save(r);
    return scope.run(st, async () => {
      const began = Date.now(); let timer, failed;
      const work = Promise.resolve().then(() => { alive(st); return task(); });
      try {
        await Promise.race([work, new Promise((_, reject) => {
          timer = setTimeout(() => { st.controller.abort(); reject(new ProbeFailure('timeout', 'deadline')); }, Math.max(1, st.deadline - Date.now()));
        })]);
        // Join all request/response guard work before any next check can start.
        while (st.work.size) {
          await Promise.race([Promise.all([...st.work]), new Promise((_, reject) => {
            setTimeout(() => reject(new ProbeFailure('timeout', 'join')), Math.max(1, st.deadline - Date.now())).unref();
          })]);
          alive(st);
        }
        must(!isolation, 'isolation_guard');
        r.checks[id] = { status: 'PASS', elapsed_ms: Date.now() - began, reason: 'ok' };
      } catch (err) {
        failed = err;
        r.checks[id] = { status: 'FAIL', elapsed_ms: Date.now() - began, reason: failureCode(id, err, st) };
      } finally { clearTimeout(timer); save(r); render(r); }
      if (failed) {
        st.controller.abort();
        // On failed check, cancel browser/IMAP/OP, then join its owned work.
        if (st.mailbox) st.mailbox.close();
        if (st.opChild) st.opChild.kill('SIGTERM');
        if (context) await stopBrowser();
        const joined = await Promise.race([
          Promise.allSettled([work, ...st.work]).then(() => true),
          new Promise(resolve => setTimeout(() => resolve(false), 2000)),
        ]);
        st.closed = true;
        if (!joined || r.checks[id].reason.includes('_timeout_')) {
          // No next check after timeout/unjoined work. EXIT trap bounds group kill
          // and preserves any pending successor. Unrun checks stay prerequisite FAIL.
          r.checks.F = { status: 'FAIL', elapsed_ms: 0, reason: 'F_timeout_probe_stopped' };
          save(r); render(r);
          // Keep this owner alive for the wrapper to enumerate detached Chromium
          // descendants before killing/joining them. No next check or helper runs.
          await new Promise(() => {});
        }
      }
      st.closed = true;
    });
  }
  function runOpEdit() {
    const st = state(); alive(st);
    return new Promise((resolve, reject) => {
      const fd = fs.openSync(secret('op-edit.out'), 'w', 0o600), err = fs.openSync(secret('op-edit.err'), 'w', 0o600);
      const child = spawn('op', ['item', 'edit', item.id, '--vault', 'CommonSwarm Smoke', '--template', secret('item-next.json')], {
        env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: fs.readFileSync(secret('op-token.txt'), 'utf8') }, stdio: ['ignore', fd, err],
      });
      st.opChild = child; fs.closeSync(fd); fs.closeSync(err);
      let timedOut = false, killer;
      const stop = () => { timedOut = true; child.kill('SIGTERM'); killer ??= setTimeout(() => child.kill('SIGKILL'), 500); };
      const timer = setTimeout(stop, remaining(15_000));
      st.controller.signal.addEventListener('abort', stop, { once: true });
      // Resolve/reject only on close, after process and stdio have joined.
      child.on('error', () => {});
      child.on('close', code => {
        clearTimeout(timer); clearTimeout(killer); st.controller.signal.removeEventListener('abort', stop); st.opChild = undefined;
        if (timedOut) reject(new ProbeFailure('rotation', 'save_timeout'));
        else if (code !== 0) reject(new ProbeFailure('rotation', 'save_failed'));
        else { try { alive(st); resolve(); } catch (err) { reject(err); } }
      });
    });
  }
  // Run independent MCP checks first. A rotated successor is durable before UI probes.
  await check('E0', 55_000, async () => {
    const disco = await request(`${ISSUER}/.well-known/openid-configuration`); must(disco.status === 200);
    const metadata = await disco.json(); must(metadata.issuer === ISSUER);
    must(new URL(metadata.token_endpoint).origin === ISSUER);
    alive(state());
    // Durable reuse guard is saved BEFORE consuming the predecessor. A later
    // runner cannot refresh an item left in_use by a lost/failed rotation.
    field('fixture_state').value = 'in_use';
    write(secret('item-next.json'), JSON.stringify(item)); write(secret('fixture.armed'), 'arm attempted');
    await runOpEdit(); alive(state());
    write(secret('rotation.inflight'), 'refresh may be consumed');
    const response = await request(metadata.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: fs.readFileSync(secret('hosted-refresh.txt'), 'utf8'),
        client_id: config.baseline_client_id, resource: `${ISSUER}/mcp` }) });
    must(response.status === 200, 'refresh_response', 'rotation');
    const token = await response.json();
    // Stage a returned successor before validating the rest of a possibly malformed response.
    if (typeof token.refresh_token === 'string' && token.refresh_token) {
      field('hosted_refresh_token').value = token.refresh_token;
      field('fixture_state').value = 'ready';
      write(secret('item-successor.tmp'), JSON.stringify(item));
      fs.renameSync(secret('item-successor.tmp'), secret('item-next.json')); write(secret('rotation.pending'), 'pending');
      alive(state()); await runOpEdit(); alive(state());
      // Rename avoids a deletion API. Presence of rotation.pending is the recovery signal.
      fs.renameSync(secret('rotation.pending'), secret('rotation.saved'));
      fs.renameSync(secret('rotation.inflight'), secret('rotation.complete'));
    } else throw new ProbeFailure('rotation', 'successor_missing');
    must(typeof token.access_token === 'string' && token.token_type?.toLowerCase() === 'bearer');
    write(secret('hosted-access.txt'), token.access_token); mcpBearer = token.access_token;
    const initialized = await rpc('smoke-init', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cs-smoke', version: '1' } });
    must(initialized.result.protocolVersion === '2025-06-18');
    const notice = await request(`${ISSUER}/mcp`, { method: 'POST', headers: mcpHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }); must(notice.status === 202); initOk = true;
    controlIdentity = await whoami('smoke-control', false);
  });
  await check('E1', 65_000, async () => {
    prerequisite(mcpBearer && initOk && !fs.existsSync(secret('rotation.pending')));
    const identity = await whoami('smoke-meta', true);
    must(controlIdentity && JSON.stringify(identity) === JSON.stringify(controlIdentity), 'positive_control_failed');
  });
  function mcpHeaders() { return { authorization: `Bearer ${mcpBearer}`, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }; }
  async function rpc(id, method, params) {
    const response = await request(`${ISSUER}/mcp`, { method: 'POST', headers: mcpHeaders(), body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    must(response.status === 200); const result = await response.json();
    must(result.id === id && result.jsonrpc === '2.0' && !result.error && result.result && result.result.isError !== true); return result;
  }
  async function whoami(id, meta) {
    const result = await rpc(id, 'tools/call', { name: 'whoami', arguments: { seat: config.seat_handle }, ...(meta ? { _meta: { progressToken: 'smoke' } } : {}) });
    const texts = result.result.content.filter(c => c.type === 'text'); must(texts.length === 1);
    const v = JSON.parse(texts[0].text);
    must(v.workspace_id === config.workspace_id && v.grant_id === config.baseline_grant_id && v.handle === config.seat_handle && v.name === config.seat_name);
    return { workspace_id: v.workspace_id, grant_id: v.grant_id, handle: v.handle, name: v.name };
  }

  const requireTools = createRequire(path.join(tools, 'package.json'));
  const watched = new WeakSet();
  let ImapFlow, simpleParser;
  await check('A', 90_000, async () => {
    const html = await request(`${SITE}/app`); must(html.status === 200 && html.headers.get('content-type')?.includes('text/html'));
    const { chromium } = await import(pathToFileURL(requireTools.resolve('playwright')).href);
    ({ ImapFlow } = requireTools('imapflow')); ({ simpleParser } = requireTools('mailparser'));
    prerequisite(typeof process.env.PLAYWRIGHT_BROWSERS_PATH === 'string' && process.env.PLAYWRIGHT_BROWSERS_PATH.length > 0);
    const executable = fs.realpathSync(chromium.executablePath());
    must(executable.startsWith(fs.realpathSync(process.env.PLAYWRIGHT_BROWSERS_PATH) + path.sep));
    context = await chromium.launchPersistentContext(secret('profile'), { headless: true, executablePath: executable,
      args: ['--password-store=basic', '--use-mock-keychain', '--no-sandbox'], acceptDownloads: true, viewport: { width: 1440, height: 1000 }, timeout: remaining(20_000),
      serviceWorkers: 'block' });
    liveContext = context;
    context.on('page', p => watch(p));
    page = context.pages()[0] || await context.newPage(); watch(page);
    // CDP exposes original wire headers even when CORS hides the response from
    // fetch/Playwright response events. It never fulfills or rewrites a response.
    const wire = await context.newCDPSession(page); await wire.send('Network.enable');
    wire.on('Network.requestWillBeSent', event => {
      const st = currentCheck;
      if (event.request.method === 'PUT' && st && !st.closed && !st.controller.signal.aborted) {
        // The app can start PUT before our create-response body read finishes.
        // Keep signed URLs and check owners private until the route associates one.
        putCandidates.set(event.requestId, { request: Object.freeze({ id: event.requestId, url: event.request.url, st }), raw: undefined });
      }
    });
    wire.on('Network.responseReceivedExtraInfo', event => {
      const candidate = putCandidates.get(event.requestId); if (!candidate) return;
      ownGuard(candidate.request.st, async () => {
        candidate.raw = { status: event.statusCode, headers: event.headers };
        if (candidate === associatedPut) acceptPutReceipt(candidate);
      });
    });
    context.on('requestfailed', req => {
      const record = observed.get(req); if (!record) return;
      ownGuard(record.st, async () => {
        try {
          if (record.kind === 'put') await pause(100);
          isolation = true;
          record.st.failure ??= new ProbeFailure('assertion', record.kind === 'put' ? 'put_transport' : 'response_transport');
        } finally { record.finish(); observed.delete(req); }
      });
    });
    context.on('response', observeResponse);
    await context.route('**/*', route => ownGuard(currentCheck, () => routeGuard(route)));
    const scripts = [];
    page.on('response', response => { if (response.request().resourceType() === 'script' && new URL(response.url()).origin === SITE) scripts.push(response.status()); });
    must((await page.goto(`${SITE}/app`, { waitUntil: 'load', timeout: remaining(20_000) })).status() === 200);
    await page.locator('[data-panel="signed-out"]').waitFor({ state: 'visible', timeout: remaining(20_000) });
    must(scripts.length > 0 && scripts.every(s => s === 200));
    must(r.console_errors === 0 && r.page_errors === 0);
  });
  function watch(p) {
    if (watched.has(p)) return; watched.add(p);
    p.on('console', msg => { if (msg.type() === 'error') r.console_errors++; });
    p.on('pageerror', () => r.page_errors++);
  }
  async function workspaceUI() {
    await page.locator(`[data-rail-workspace="${config.workspace_id}"][aria-current="page"]`).waitFor({ state: 'visible', timeout: remaining(20_000) });
    must((await page.locator(`[data-rail-workspace="${config.workspace_id}"] .hm-rail__name`).innerText()).trim() === config.workspace_name);
    const header = page.locator(`[data-home-workspace-header="${config.workspace_id}"]`);
    await header.waitFor({ state: 'visible', timeout: remaining(20_000) });
    must((await header.locator('h1').innerText()).trim() === config.workspace_name);
    must(await page.locator('[data-rail-workspace]').count() === 1);
  }
  await check('B', 150_000, async () => {
    prerequisite(context && !browserBroken && r.checks.A.status === 'PASS');
    const mailbox = new ImapFlow({ host: config.mailbox.host, port: 993, secure: true,
      auth: { user: config.mailbox.username, pass: config.mailbox.password }, logger: false,
      connectionTimeout: remaining(10_000), greetingTimeout: remaining(10_000), socketTimeout: remaining(10_000) });
    state().mailbox = mailbox;
    try {
      await mailbox.connect(); await mailbox.mailboxOpen('INBOX'); const firstUid = mailbox.mailbox.uidNext;
      await page.locator('#dashboard-email').fill(config.test_email, { timeout: remaining(20_000) });
      const otp = page.waitForResponse(res => new URL(res.url()).pathname === '/auth/v1/otp', { timeout: remaining(15_000) });
      await page.getByRole('button', { name: 'Email me a sign-in link', exact: true }).click({ timeout: remaining(20_000) });
      must((await otp).status() === 200);
      let link;
      while (!link) {
        must(!browserBroken && !isolation); remaining(1); await mailbox.noop();
        // Only the exclusive TEST mailbox is accessed. Never an employee mailbox.
        const ids = await mailbox.search({ uid: `${firstUid}:*` }, { uid: true });
        for (const uid of ids.filter(id => id >= firstUid)) {
          const message = await mailbox.fetchOne(uid, { source: true }, { uid: true });
          const parsed = await simpleParser(message.source);
          must(parsed.to?.value.some(v => v.address?.toLowerCase() === config.test_email.toLowerCase()));
          const urls = `${parsed.text || ''}\n${parsed.html || ''}`.match(/https:\/\/[^\s<>"']+/g) || [];
          for (const candidate of urls) {
            let u; try { u = new URL(candidate.replaceAll('&amp;', '&')); } catch { continue; }
            if (u.origin === API && u.pathname === '/auth/v1/verify' && u.searchParams.get('type') === 'magiclink') {
              const dest = u.searchParams.get('redirect_to');
              must(dest && new URL(dest).origin === SITE && new URL(dest).pathname === '/app'); link = u.href; break;
            }
          }
          if (link) break;
        }
        if (!link) await pause(1000);
      }
      await page.goto(link, { waitUntil: 'load', timeout: remaining(20_000) });
      await page.waitForFunction(expected => {
        for (const key of Object.keys(localStorage)) {
          if (!/^sb-.*-auth-token$/.test(key)) continue;
          try { const s = JSON.parse(localStorage.getItem(key)); if (s?.user?.id === expected && s.access_token) return true; } catch {}
        }
        return false;
      }, config.test_user_id, { timeout: remaining(20_000) });
      const session = await page.evaluate(() => {
        const found = Object.keys(localStorage).filter(k => /^sb-.*-auth-token$/.test(k)).map(k => JSON.parse(localStorage.getItem(k))).filter(s => s?.access_token);
        if (found.length !== 1) return null; return found[0];
      });
      must(session?.user?.id === config.test_user_id && session.user.email.toLowerCase() === config.test_email.toLowerCase());
      appToken = session.access_token;
      const user = await request(`${API}/auth/v1/user`, { headers: { authorization: `Bearer ${appToken}`, apikey: config.app_anon_key } });
      must(user.status === 200); const identity = await user.json();
      must(identity.id === config.test_user_id && identity.email.toLowerCase() === config.test_email.toLowerCase()); authenticated = true;
      await page.goto(`${SITE}/app?w=${config.workspace_id}`, { waitUntil: 'load', timeout: remaining(20_000) }); await workspaceUI();
    } finally { mailbox.close(); }
  });

  await check('C', 210_000, async () => {
    prerequisite(authenticated && !browserBroken && r.checks.B.status === 'PASS'); await workspaceUI();
    png = Buffer.from(await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = c.height = 2;
      c.getContext('2d').fillStyle = '#808080'; c.getContext('2d').fillRect(0, 0, 2, 2); return c.toDataURL('image/png').split(',')[1];
    }), 'base64');
    await page.locator('[data-composer-file-input]').setInputFiles({ name: 'cs-smoke.png', mimeType: 'image/png', buffer: png }, { timeout: remaining(20_000) });
    await page.locator('[data-composer-input]').fill(FIXED, { timeout: remaining(20_000) });
    await page.locator('[data-composer-send]').click({ timeout: remaining(20_000) });
    while (!signalId) { must(!isolation && !browserBroken); await pause(100); }
    await waitStage('post');
    await waitPutReceipt();
    must(sequence.join(',') === 'create,put,commit,post');
    await page.goto(`${SITE}/app?w=${config.workspace_id}`, { waitUntil: 'load', timeout: remaining(20_000) }); await workspaceUI();
    const row = page.locator(`[data-signal-id="${signalId}"]`); await row.waitFor({ state: 'visible', timeout: remaining(20_000) });
    must((await row.locator('.dashboard__message-markdown').innerText()).trim() === FIXED);
    const card = row.locator(`[data-stream-files] a[data-object-id="${fileId}"][data-kind="file"]`);
    must(await row.locator('[data-stream-files] a').count() === 1);
    must((await card.locator('.hm-object-title').innerText()).trim() === 'cs-smoke.png');
    let downloaded;
    // The actual file-card click obtains its signed URL. The guard independently reads that exact GET.
    const receipt = new Promise(resolve => { downloaded = resolve; });
    captureDownload = downloaded;
    await card.click({ timeout: remaining(20_000) });
    const data = await receipt; await waitStage('download');
    must(data.status === 200 && data.type.startsWith('image/png') && hash(data.bytes) === hash(png));
    must(data.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      data.bytes.readUInt32BE(16) === 2 && data.bytes.readUInt32BE(20) === 2);
  });

  await check('D1', 260_000, async () => {
    prerequisite(context && !browserBroken && !isolation);
    await context.addCookies(cookies); consentPage = await context.newPage();
    let consentDocument;
    consentPage.on('response', response => {
      const u = new URL(response.url());
      if (response.request().resourceType() === 'document' && u.origin === ISSUER && /^\/interaction\/[^/]+\/?$/.test(u.pathname))
        consentDocument = { url: u.href, status: response.status(), type: response.headers()['content-type'] || '' };
    });
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${ISSUER}/authorize`);
    authorize.search = new URLSearchParams({ response_type: 'code', client_id: config.oauth_client_id,
      redirect_uri: config.oauth_redirect_uri, resource: `${ISSUER}/mcp`, scope: 'openid offline_access mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state, prompt: 'consent' });
    let callback;
    const callbackDone = new Promise(resolve => { callback = resolve; });
    interceptCallback = async route => {
      const u = new URL(route.request().url()); callbackCount++;
      must(u.searchParams.get('state') === state && u.searchParams.get('code') && !u.searchParams.has('error') && callbackCount === 1);
      await route.abort('aborted'); callback();
    };
    await consentPage.goto(authorize.href, { waitUntil: 'domcontentloaded', timeout: remaining(20_000) });
    // Force the configured provider at the first interaction, even with one enabled provider.
    while (!(await consentPage.locator('form[action$="/consent"]').count())) {
      must(!isolation && !browserBroken); const u = new URL(consentPage.url());
      if (u.origin === ISSUER && /^\/interaction\/[^/]+\/?$/.test(u.pathname)) {
        const exactHref = `${u.pathname.replace(/\/$/, '')}/sign-in?provider=${config.oauth_provider}`;
        const choice = consentPage.locator(`a[href="${exactHref}"]`);
        if (await choice.count()) await choice.click({ timeout: remaining(20_000) });
        else await pause(200);
      } else await pause(200);
    }
    const consentUrl = new URL(consentPage.url()); must(consentUrl.origin === ISSUER && /^\/interaction\/[^/]+\/?$/.test(consentUrl.pathname));
    must(consentDocument?.url === consentUrl.href && consentDocument.status === 200 && consentDocument.type.includes('text/html'));
    const label = (await consentPage.locator('.account-text').innerText()).trim();
    must(label.includes(config.test_email) || label.includes(config.test_display_name));
    const choices = consentPage.locator('input[name="workspace_ids"][type="checkbox"]');
    const ids = await choices.evaluateAll(inputs => inputs.map(i => i.value));
    must(ids.length === 1 && ids[0] === config.workspace_id);
    await choices.uncheck({ timeout: remaining(20_000) }); await choices.check({ timeout: remaining(20_000) });
    await consentPage.locator(`input[name="home_workspace_id"][value="${config.workspace_id}"]`).check({ timeout: remaining(20_000) });
    const form = consentPage.locator('form[action$="/consent"]');
    const saved = await form.evaluate(f => ({ action: f.action, body: new URLSearchParams(new FormData(f)).toString() }));
    originalAction = saved.action; originalBody = saved.body;
    r.leftovers.push('consent-probe-grant-possible'); save(r);
    await form.getByRole('button', { name: 'Allow connection', exact: true }).click({ timeout: remaining(20_000) }); await callbackDone;
    must(callbackCount === 1);
    r.leftovers = r.leftovers.filter(v => v !== 'consent-probe-grant-possible');
    r.leftovers.push('consent-probe-grant-retained');
  });
  await check('D2', 270_000, async () => {
    prerequisite(r.checks.D1.status === 'PASS' && originalAction && originalBody && !browserBroken);
    const replay = await context.request.post(originalAction, { data: originalBody,
      headers: { Accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded', Origin: ISSUER },
      maxRedirects: 0, timeout: remaining(15_000) });
    must(replay.status() === 409 && replay.headers()['content-type']?.includes('text/html'));
    const result = await context.newPage(); await result.setContent(await replay.text(), { timeout: remaining(10_000) });
    must((await result.locator('h1').innerText()).trim() === 'Already approved');
    const links = await result.locator('.actions a').evaluateAll(nodes => nodes.map(n => n.getAttribute('href')));
    must(links.length === 1 && [config.oauth_return_url, `${SITE}/app`].includes(links[0]));
    must(callbackCount === 1); await result.close();
  });

  await check('F', 280_000, async () => {
    // Recorded IDs exist only after the exact TEST envelope/bearer guard.
    // Tombstone those IDs even after a CORS failure; preserve the failed guard result.
    if (fileId) {
      prerequisite(authenticated && appToken && uuid(fileId) && commandVersion && commandHeaders);
      const response = await request(`${API}/functions/v1/command`, { method: 'POST',
        headers: { authorization: `Bearer ${appToken}`, apikey: commandHeaders.apikey, 'content-type': 'application/json' },
        body: JSON.stringify({ command_id: randomUUID(), client_version: commandVersion, workspace_id: config.workspace_id,
          stream: { kind: 'workspace' }, command: { kind: 'file_tombstone', file_id: fileId } }) });
      must(response.status === 200 && (await response.json()).status === 'accepted');
      r.leftovers = r.leftovers.filter(v => v !== `file:${fileId}`);
    }
    if (context) await context.close();
    must(!isolation, 'isolation_guard');
  });
  if (r.console_errors || r.page_errors) r.checks.A = { ...r.checks.A, status: 'FAIL', reason: 'A_assertion_console_or_page_error' };
  r.total_elapsed_ms = Date.now() - t0; save(r); render(r);
  process.exitCode = IDS.every(id => r.checks[id].status === 'PASS') ? 0 : 1;

  // Response work is owned by the request's immutable check. Only route.continue
  // forwards product traffic: no route.fetch/fulfill and no repaired CORS headers.
  function ownGuard(st, task) {
    if (!st) return Promise.reject(new ProbeFailure('prerequisite', 'guard_state'));
    const promise = scope.run(st, async () => {
      try { alive(st); await task(); }
      catch (err) { isolation = true; st.failure ??= err instanceof ProbeFailure ? err : new ProbeFailure('assertion', 'guard_operation'); }
    });
    st.work.add(promise); promise.finally(() => st.work.delete(promise)); return promise;
  }
  function expectResponse(req, kind) {
    const st = state(); let finish;
    const done = new Promise(resolve => { finish = resolve; });
    st.work.add(done);
    stages[kind] = done; observed.set(req, { st, kind, finish: () => { st.work.delete(done); finish(); } });
  }
  async function waitStage(kind) { prerequisite(stages[kind]); await stages[kind]; alive(state()); must(!isolation, 'response_guard'); }
  function acceptPutReceipt(candidate) {
    alive(state());
    must(candidate === associatedPut && candidate.request.st === state() && candidate.request.url === uploadUrl, 'put_wire_owner');
    const headers = Object.fromEntries(Object.entries(candidate.raw.headers).map(([k, v]) => [k.toLowerCase(), v]));
    must(candidate.raw.status >= 200 && candidate.raw.status < 300, 'put_status');
    must([SITE, '*'].includes(headers['access-control-allow-origin']), 'put_acao');
    putWireReceipt = candidate;
  }
  async function associatePut() {
    must(!associatedPut, 'put_association');
    for (;;) {
      alive(state()); must(!isolation && !browserBroken, 'put_association');
      const matches = [...putCandidates.values()].filter(c => c.request.st === state() && c.request.url === uploadUrl);
      must(matches.length <= 1, 'put_association');
      if (matches.length === 1) {
        associatedPut = matches[0];
        if (associatedPut.raw) acceptPutReceipt(associatedPut);
        return;
      }
      // CDP and Playwright route callbacks can arrive in either order.
      await pause(10);
    }
  }
  async function waitPutReceipt() {
    while (!associatedPut || putWireReceipt !== associatedPut) {
      must(!isolation && !browserBroken, 'put_wire_headers'); await pause(10);
    }
    alive(state());
    must(putWireReceipt.request.st === state() && putWireReceipt.request.url === uploadUrl, 'put_wire_owner');
  }
  function observeResponse(response) {
    const record = observed.get(response.request()); if (!record) return;
    ownGuard(record.st, async () => {
      try {
        const { kind } = record, status = response.status();
        if (kind === 'put') {
          const headers = await response.allHeaders(); alive(state());
          must(status >= 200 && status < 300, 'put_status');
          must([SITE, '*'].includes(headers['access-control-allow-origin']), 'put_acao');
          sequence.push('put');
        } else if (kind === 'download') {
          // A browser download may not expose body(). Node verifies the same
          // signed GET separately before this unmodified browser navigation.
          must(status === 200 && response.headers()['content-type']?.startsWith('image/png'), 'download_response');
        } else {
          const value = await response.json(); alive(state());
          must(status === 200);
          if (kind === 'workspaces') must(Array.isArray(value) && value.length === 1 && value[0].workspace_id === config.workspace_id && value[0].name === config.workspace_name);
          else {
            must(value.status === 'accepted');
            if (kind === 'create') {
              must(value.file_id === fileId && value.version_id === versionId && value.upload_path?.startsWith('/storage/v1/object/upload/sign/'));
              const u = new URL(value.upload_path, API); must(u.origin === API);
              versionN = value.version_n; must(Number.isInteger(versionN) && versionN > 0);
              must(u.pathname === `/storage/v1/object/upload/sign/swarm-files/${config.workspace_id}/${fileId}/${versionN}`, 'upload_workspace_path');
              uploadUrl = u.href; sequence.push('create');
            } else if (kind === 'commit') { must(value.file_id === fileId && value.version_n === versionN); sequence.push('commit'); }
            else if (kind === 'post') { must(uuid(value.signal?.id)); signalId = value.signal.id; sequence.push('post'); r.leftovers.push(`signal:${signalId}`); save(r); }
            else { must(value.download_path?.startsWith('/storage/v1/')); const u = new URL(value.download_path, API); must(u.origin === API); downloadUrl = u.href; }
          }
        }
      } catch (err) {
        isolation = true; record.st.failure ??= err instanceof ProbeFailure ? err : new ProbeFailure('assertion', 'response_operation');
      } finally { record.finish(); observed.delete(response.request()); }
    });
  }
  function forward(route, options) { alive(state()); return route.continue(options); }
  // Routing guards run BEFORE sending a request. No raw request/response is logged.
  async function routeGuard(route) {
    try {
      const req = route.request(), u = new URL(req.url()), method = req.method();
      const callback = new URL(config.oauth_redirect_uri);
      if (u.origin === callback.origin && u.pathname === callback.pathname) {
        must(state().id === 'D1' && interceptCallback); return await interceptCallback(route);
      }
      must([SITE, API, ISSUER, ...config.oauth_network_origins].includes(u.origin), 'origin_guard');
      if (method === 'OPTIONS') { alive(state()); return await forward(route); }
      if (u.origin === API && (u.pathname.startsWith('/rest/v1/') || u.pathname.startsWith('/functions/v1/'))) {
        const headers = await req.allHeaders();
        if (!authenticated) {
          must(state().id === 'B' && headers.authorization?.startsWith('Bearer ') && headers.apikey === config.app_anon_key);
          identityPromise ??= (async () => {
            const h = { authorization: headers.authorization, apikey: headers.apikey };
            const identityResponse = await request(`${API}/auth/v1/user`, { headers: h });
            must(identityResponse.status === 200); const user = await identityResponse.json();
            must(user.id === config.test_user_id && user.email?.toLowerCase() === config.test_email.toLowerCase());
            // Read only IDs first. No browser content read is forwarded until membership is safe.
            const membership = await request(`${API}/rest/v1/workspaces?select=workspace_id&archived_at=is.null`,
              { headers: { ...h, 'Accept-Profile': 'swarm_read' } });
            must(membership.status === 200); const rows = await membership.json();
            must(Array.isArray(rows) && rows.length === 1 && rows[0].workspace_id === config.workspace_id);
            appToken = headers.authorization.slice(7); authenticated = true;
          })();
          await identityPromise;
        }
        must(headers.authorization === `Bearer ${appToken}`);
      }
      if (u.origin === API && u.pathname === '/auth/v1/authorize' && state().id === 'D1')
        must(u.searchParams.get('provider') === config.oauth_provider);
      if (u.origin === API && u.pathname === '/auth/v1/otp') {
        must(state().id === 'B' && method === 'POST'); const data = req.postDataJSON();
        must(data.email === config.test_email && !data.phone);
        // The real email UI sends this request. Disallow accidental account creation.
        return await forward(route, { postData: JSON.stringify({ ...data, create_user: false }) });
      }
      if (u.origin === API && u.pathname === '/functions/v1/command') {
        const body = req.postDataJSON(), cmd = body.command, headers = await req.allHeaders();
        must(authenticated && !isolation && !state().controller.signal.aborted && body.workspace_id === config.workspace_id &&
          body.stream?.kind === 'workspace' && uuid(body.command_id));
        must(headers.authorization === `Bearer ${appToken}` && headers.apikey === config.app_anon_key && body.client_version === config.web_client_version);
        const startupRead = ['household_access', 'household_activity'].includes(cmd?.kind) ||
          (cmd?.kind === 'household_tool' && cmd.tool === 'todo_list');
        if (startupRead) return await forward(route);
        must(['file_version_create', 'file_version_commit', 'post_signal', 'file_download_url', 'signals_seen'].includes(cmd?.kind));
        if (cmd.kind === 'signals_seen') return await forward(route);
        must(state().id === 'C');
        if (cmd.kind === 'file_version_commit') { await waitStage('put'); await waitPutReceipt(); }
        if (cmd.kind === 'post_signal') await waitStage('commit');
        if (cmd.kind === 'file_download_url') await waitStage('post');
        if (cmd.kind === 'file_version_create') {
          must(sequence.length === 0 && cmd.name === 'cs-smoke.png' && cmd.content_type === 'image/png' && cmd.declared_size_bytes === png.length && uuid(cmd.file_id) && uuid(cmd.version_id));
          // Save intended IDs before sending, even if the response is lost.
          fileId = cmd.file_id; versionId = cmd.version_id; commandHeaders = headers; commandVersion = body.client_version;
          r.leftovers.push(`file:${fileId}`); save(r);
        } else if (cmd.kind === 'file_version_commit') must(sequence.join(',') === 'create,put' && cmd.file_id === fileId && cmd.version_id === versionId && cmd.sha256 === hash(png));
        else if (cmd.kind === 'post_signal') {
          must(sequence.join(',') === 'create,put,commit' && cmd.body === FIXED && cmd.signal_kind === 'note' &&
            (!cmd.to || cmd.to.length === 0) && !cmd.to_user_id && !cmd.to_agent_principal_id && !cmd.in_reply_to && !cmd.about && !cmd.channel && !cmd.thread_root_id && !cmd.broadcast_to_channel);
          must(cmd.attachments?.length === 1 && cmd.attachments[0].file_id === fileId && cmd.attachments[0].version_n === versionN);
        } else must(cmd.file_id === fileId && cmd.version_n === versionN && sequence.join(',') === 'create,put,commit,post');
        expectResponse(req, { file_version_create: 'create', file_version_commit: 'commit', post_signal: 'post', file_download_url: 'download_url' }[cmd.kind]);
        alive(state()); return await forward(route);
      }
      if (u.origin === API && u.pathname.startsWith('/storage/v1/')) {
        must(state().id === 'C' && authenticated && !isolation); alive(state());
        if (method === 'PUT') {
          await waitStage('create');
          must(req.url() === uploadUrl && sequence.join(',') === 'create' && hash(req.postDataBuffer()) === hash(png));
          await associatePut();
          // Mandatory real preflight, independent of Playwright's synthetic OPTIONS.
          // No bearer is sent. Never print the signed URL or its query token.
          const preflight = await request(uploadUrl, { method: 'OPTIONS', headers: {
            Origin: SITE, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type',
          } });
          must(preflight.status >= 200 && preflight.status < 300, 'preflight_status');
          must([SITE, '*'].includes(preflight.headers.get('access-control-allow-origin')), 'preflight_acao');
          const list = name => (preflight.headers.get(name) || '').toLowerCase().split(',').map(v => v.trim());
          must(list('access-control-allow-methods').includes('put') || list('access-control-allow-methods').includes('*'), 'preflight_method');
          must(list('access-control-allow-headers').includes('content-type') || list('access-control-allow-headers').includes('*'), 'preflight_header');
          await preflight.arrayBuffer(); alive(state());
          expectResponse(req, 'put'); return await forward(route);
        }
        await waitStage('download_url'); must(method === 'GET' && req.url() === downloadUrl && captureDownload);
        const response = await request(downloadUrl); const bytes = Buffer.from(await response.arrayBuffer()); alive(state());
        captureDownload({ status: response.status, type: response.headers.get('content-type') || '', bytes });
        expectResponse(req, 'download'); return await forward(route);
      }
      if (u.origin === API && u.pathname === '/functions/v1/read') {
        const body = req.postDataJSON(); if (body.workspace_id !== undefined) must(body.workspace_id === config.workspace_id);
      }
      if (u.origin === API && u.pathname.startsWith('/rest/v1/')) {
        const w = u.searchParams.get('workspace_id'); if (w) must(w === `eq.${config.workspace_id}`);
        if (u.pathname === '/rest/v1/workspaces') {
          expectResponse(req, 'workspaces'); return await forward(route);
        }
        if (!u.pathname.includes('/rpc/'))
          must(w === `eq.${config.workspace_id}`);
        if (u.pathname === '/rest/v1/rpc/signal_delivery_receipts')
          must(req.postDataJSON().p_workspace_id === config.workspace_id);
      }
      if (u.origin === ISSUER && method === 'POST' && /\/consent$/.test(u.pathname)) {
        must(state().id === 'D1' && originalAction === u.href && originalBody === req.postData());
        const body = new URLSearchParams(req.postData());
        must(body.getAll('workspace_ids').length === 1 && body.get('workspace_ids') === config.workspace_id && body.get('home_workspace_id') === config.workspace_id);
      }
      // Permit normal auth redirects and read traffic. All other product writes fail closed.
      if (![ 'GET', 'HEAD', 'OPTIONS' ].includes(method) && [SITE, API, ISSUER].includes(u.origin)) {
        const authWrite = u.origin === API && ['/auth/v1/token', '/auth/v1/verify'].includes(u.pathname);
        const consentWrite = u.origin === ISSUER && /\/interaction\/[^/]+\/consent$/.test(u.pathname) && state().id === 'D1';
        const readPost = u.origin === API && u.pathname === '/functions/v1/read';
        const readRpc = u.origin === API && ['/rest/v1/rpc/home_overview', '/rest/v1/rpc/signal_delivery_receipts'].includes(u.pathname);
        must(authWrite || consentWrite || readPost || readRpc);
      }
      alive(state()); return await forward(route);
    } catch (err) {
      isolation = true; state().failure ??= err instanceof ProbeFailure ? err : new ProbeFailure('assertion', 'guard_operation');
      await route.abort('blockedbyclient').catch(() => {});
    }
  }
}
// Hoisted bindings used by routing closures, assigned only within their checks.
let captureDownload, interceptCallback;
main().catch(() => {
  process.exitCode = 1;
  if (mode === 'run' && evidence) {
    try { const r = loadReport(); for (const id of IDS) if (r.checks[id].reason.endsWith('_prerequisite_setup')) r.checks[id].reason = `${id}_prerequisite_fixture_or_setup`; save(r); render(r); } catch {}
  }
}).finally(async () => {
  if (liveContext) {
    await Promise.race([liveContext.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000).unref())]);
  }
});

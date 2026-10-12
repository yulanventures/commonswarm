/** Exercise all five production log filters with dummy redirects; output pass/fail only.
 * Real Caddy supplies JSON logs; request credentials must be absent from every record.
 * Request and redirect credentials are distinct; each phase uses fresh connections.
 * Removing each Location rule must expose dummy credentials;
 * live/maintenance pair reloads must preserve filtering. Missing Caddy fails in CI. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const names = ['mcp', 'api', 'edge-staging', 'api-maintenance', 'edge-staging-maintenance'];
const redirect = 'https://client.invalid/callback?code=DUMMYCODE&state=DUMMYSTATE#access_token=DUMMYACCESS&refresh_token=DUMMYREFRESH';
const dummies = ['DUMMYCODE', 'DUMMYSTATE', 'DUMMYACCESS', 'DUMMYREFRESH'];
// Go's canonical header names are the keys emitted by Caddy's request logger.
const requestCredentials = {
  Authorization: 'Bearer DUMMYREQUESTACCESS', Cookie: 'refresh_token=DUMMYREQUESTREFRESH',
  Apikey: 'DUMMYAPIKEY', Dpop: 'DUMMYDPOP',
  'X-Cswarm-Session-Key': 'DUMMYSESSIONKEY', 'X-Cswarm-Csrf': 'DUMMYCSRF',
  'X-Cswarm-Hosted-Capability': 'DUMMYHOSTEDCAPABILITY',
  'X-Commonswarm-Hosted-Capability': 'DUMMYHOSTEDALIAS',
  'X-Cswarm-Key': 'DUMMYLEGACYKEY', 'X-Phoenix-Authtoken': 'DUMMYPHOENIXTOKEN',
};
const boxVersion = 'v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=';

/** Execute the CI checksum gate against local bytes; no download or Caddy is needed.
 * A matching SHA-512 succeeds; corrupt archives, pins and publisher rows fail closed. */
test('P0: CI checksum gate accepts SHA-512 and rejects mismatched evidence', t => {
  const workflow = readFileSync(new URL('../../../.github/workflows/server-suite.yml', import.meta.url), 'utf8');
  const step = workflow.split('- name: Install box-matched Caddy for server and unit\n')[1].split('      - name:')[0];
  const pin = step.match(/(CADDY_ARCHIVE_SHA(?:256|512)): (\S+)/);
  assert.ok(pin, 'literal archive checksum is required');
  const gate = step.slice(step.indexOf('          publisher_sha='), step.indexOf('          tar -xzf'));
  const root = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(join(root, 'caddy-checksum-')));
  t.after(() => {
    assert.equal(dirname(directory), root);
    assert.match(directory.slice(root.length + 1), /^caddy-checksum-[A-Za-z0-9]{6}$/);
    const cleanup = spawnSync('rm', ['-r', '--', directory], { encoding: 'utf8' });
    assert.equal(cleanup.status, 0, `fixture cleanup refused ${directory}: ${cleanup.stderr}`);
  });
  const archive = 'caddy_2.11.4_linux_amd64.tar.gz', bytes = 'synthetic archive';
  const digest = createHash('sha512').update(bytes).digest('hex');
  const row = `${digest}  ${archive}\n`;
  // macOS sha512sum lacks GNU long flags; use its real shasum verifier locally.
  const platform = process.platform === 'darwin' ? 'sha512sum() { shasum -a 512 "$@"; }\n' : '';
  for (const [label, contents, publisher, expectedPin, accepted] of [
    ['matching evidence', bytes, row, digest, true],
    ['corrupt archive', bytes + 'corrupt', row, digest, false],
    ['wrong pin', bytes, row, '0'.repeat(128), false],
    ['duplicate publisher row', bytes, row + row, digest, false],
    ['missing publisher row', bytes, '', digest, false],
    ['SHA-256 publisher row', bytes, `${'a'.repeat(64)}  ${archive}\n`, digest, false],
  ]) {
    writeFileSync(join(directory, archive), contents);
    writeFileSync(join(directory, 'checksums.txt'), publisher);
    const result = spawnSync('/bin/bash', ['-c', 'set -euo pipefail\n' + platform + gate], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, caddy_stage: directory, archive, [pin[1]]: expectedPin },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'checksum refusal must be a shell exit');
    assert.equal(result.status === 0, accepted, `${label}: ${result.stderr}`);
  }
  // Independent box fact confirmed by HezLead from the official publisher file.
  assert.equal(pin[2], '8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9');
});

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

// Separate top-level cases: a protected-phase failure cannot prevent the exposure control.
for (const control of [false, true]) test(control
  ? 'P0: independent rule-removal controls expose dummy Locations for all five filters'
  : 'P0: real filters remove credential Locations, including paired maintenance swaps', { timeout: 60_000 }, async t => {
  const located = spawnSync('/bin/sh', ['-c', 'command -v caddy'], { encoding: 'utf8' });
  const candidate = process.env.C1_CADDY_BINARY || located.stdout.trim();
  if (!candidate) {
    assert.notEqual(process.env.CI, 'true', 'CI requires the box-matched Caddy binary');
    t.skip('CI only: Caddy is unavailable locally');
    return;
  }
  const binary = realpathSync(candidate);
  const version = spawnSync(binary, ['version'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(version.status, 0, 'Caddy must be usable');
  assert.equal(version.stdout.trim(), boxVersion, 'Caddy must match the measured official box build');
  const root = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(join(root, 'caddy-location-')));
  const realHome = realpathSync(userInfo().homedir);
  assert.ok(directory !== realHome && !directory.startsWith(realHome + sep));
  const address = `unix/${join(directory, 'admin.sock')}`;
  const config = join(directory, 'Caddyfile');
  let child;
  try {
    // Extract the actual encoder, preserving every filter rather than duplicating its inventory.
    const filters = names.map(name => {
      const source = readFileSync(new URL(`../../../deploy/supabase-stack/commonswarm-${name}.caddy`, import.meta.url), 'utf8');
      const matches = [...source.matchAll(/\t\tformat filter \{[\s\S]*?\n\t\t\}/g)];
      assert.equal(matches.length, 1, `${name}: exactly one real filter`);
      return matches[0][0];
    });
    const ports = [];
    for (const name of names) ports.push(await freePort());
    assert.equal(new Set(ports).size, names.length, 'distinct fixture listener ports');
    function configure(phase, entries, removeRule = false) {
      const sites = entries.map(([filterIndex, portIndex]) => {
        let filter = filters[filterIndex];
        if (removeRule) {
          const rule = /[ \t]*resp_headers>Location delete\n/g;
          assert.equal([...filter.matchAll(rule)].length, 1, 'control removes exactly one rule');
          filter = filter.replace(rule, '');
        }
        return `http://127.0.0.1:${ports[portIndex]} {
          log {
            output file ${join(directory, `${phase}-${filterIndex}.jsonl`)}
            ${filter}
          }
          header Location "${redirect}"
          header Set-Cookie "fixture=DUMMYCOOKIE; HttpOnly"
          header X-Fixture-Harmless "retained"
          respond "" 303
        }`;
      });
      writeFileSync(config, `{\n auto_https off\n admin ${address}\n}\n${sites.join('\n')}\n`);
    }
    async function inspect(phase, entries, protectedLog) {
      for (const [filterIndex, portIndex] of entries) {
        await t.test(`${phase}: ${names[filterIndex]}`, async () => {
          // Dummy credentials only; manual redirects retain Location on the wire.
          const response = await fetch(`http://127.0.0.1:${ports[portIndex]}/auth/v1/verify?code=DUMMYCODE`, {
            redirect: 'manual', signal: AbortSignal.timeout(5000),
            // Caddy reloads close idle sockets; do not reuse a pre-swap fetch connection.
            headers: { ...requestCredentials, 'X-Fixture-Harmless': 'retained', Connection: 'close' },
          });
          assert.equal(response.status, 303);
          assert.ok(response.headers.get('location') === redirect, 'wire redirect is preserved');
          await response.arrayBuffer();
          const log = join(directory, `${phase}-${filterIndex}.jsonl`);
          let bytes = '';
          for (let attempt = 0; attempt < 100; attempt++) {
            if (existsSync(log)) bytes = readFileSync(log, 'utf8');
            if (bytes.endsWith('\n')) break;
            await delay(20);
          }
          assert.ok(bytes.endsWith('\n'), 'JSON log must be emitted');
          const rows = bytes.trim().split('\n').map(line => JSON.parse(line));
          assert.equal(rows.length, 1, 'one request yields one access record');
          const row = rows[0];
          assert.equal(row.status, 303);
          assert.deepEqual(row.resp_headers['X-Fixture-Harmless'], ['retained']);
          assert.equal(row.request.uri, '/auth/v1/verify');
          assert.deepEqual(row.request.headers['X-Fixture-Harmless'], ['retained']);
          for (const header of Object.keys(requestCredentials)) {
            assert.ok(!Object.hasOwn(row.request.headers, header), `${header} must be redacted`);
          }
          for (const credential of Object.values(requestCredentials)) {
            assert.ok(!bytes.includes(credential), 'request credential bytes must be redacted');
          }
          assert.ok(!Object.hasOwn(row.resp_headers, 'Set-Cookie'));
          assert.ok(!bytes.includes('DUMMYCOOKIE'));
          assert.equal(Object.hasOwn(row.resp_headers, 'Location'), !protectedLog);
          for (const dummy of dummies) assert.equal(bytes.includes(dummy), !protectedLog, 'dummy credential exposure control');
          // Never include access record bytes in assertion messages or test output.
        });
      }
    }
    const all = names.map((name, index) => [index, index]);
    const initial = control ? 'rule-removal-control' : 'live';
    configure(initial, all, control);
    child = spawn(binary, ['run', '--config', config, '--adapter', 'caddyfile'], { stdio: 'ignore' });
    const stopped = once(child, 'exit');
    // TCP readiness probes do not create access-log records.
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      assert.equal(child.exitCode, null, 'fixture Caddy must stay running');
      ready = await new Promise(resolve => {
        const socket = createConnection({ host: '127.0.0.1', port: ports[0] });
        socket.setTimeout(100);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => resolve(false));
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
      });
      if (!ready) await delay(20);
    }
    assert.ok(ready, 'fixture Caddy must become ready');
    await inspect(initial, all, !control);
    for (const [phase, entries] of control ? [] : [
      ['maintenance-pair', [[3, 1], [4, 2]]],
      ['restored-pair', [[1, 1], [2, 2]]],
    ]) {
      configure(phase, entries);
      const reload = spawnSync(binary, ['reload', '--config', config, '--adapter', 'caddyfile', '--address', address], { timeout: 5000, stdio: 'ignore' });
      assert.equal(reload.status, 0, 'pair/filter reload must succeed');
      await inspect(phase, entries, true);
    }
    child.kill('SIGTERM');
    await stopped;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGKILL');
      await stopped;
    }
    assert.equal(dirname(directory), root);
    assert.match(directory.slice(root.length + 1), /^caddy-location-[A-Za-z0-9]{6}$/);
    const cleanup = spawnSync('rm', ['-r', '--', directory], { encoding: 'utf8' });
    assert.equal(cleanup.status, 0, `fixture cleanup refused ${directory}: ${cleanup.stderr}`);
  }
});

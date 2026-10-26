import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { createTemporary, removeTemporary } from './box-dry-run/temporary.js';

const origin = 'https://staging.example.invalid';
const workspace = '11111111-1111-4111-8111-111111111111';
const stagingAddress = '157.90.159.116';
const principal = '22222222-2222-4222-8222-222222222222';

let certificateRoot: string;
let certificates: { ca: string; wrongCA: string; key: Buffer; valid: Buffer; wrongHost: Buffer; expired: Buffer };
before(() => {
  // Keys are ephemeral, mode 0600 inside a fresh 0700 secret directory. No
  // certificate/key fixture is committed, and OpenSSL output never reaches logs.
  certificateRoot = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : realpathSync(tmpdir()), 'anvil-secret.'));
  chmodSync(certificateRoot, 0o700);
  const put = (name: string, content: string) => writeFileSync(join(certificateRoot, name), content, { mode: 0o600 });
  const openssl = (...args: string[]) => {
    const result = spawnSync('openssl', args, { cwd: certificateRoot, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, 'throwaway TLS fixture generation failed');
  };
  const key = () => generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).privateKey;
  for (const name of ['ca', 'wrong-ca']) {
    put(name + '.key', key());
    put(name + '.cnf', `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=${name}\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n`);
    openssl('req', '-new', '-x509', '-key', name + '.key', '-out', name + '.pem', '-days', '2', '-config', name + '.cnf');
  }
  put('leaf.key', key());
  put('index', '');
  put('index.attr', 'unique_subject = no\n');
  put('serial', '01\n');
  put('sign.cnf', '[ca]\ndefault_ca=sign\n[sign]\ndatabase=index\nserial=serial\nnew_certs_dir=.\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n');
  for (const [name, hostname] of [['valid', 'staging.example.invalid'], ['wrong-host', 'other.example.invalid'], ['expired', 'staging.example.invalid']]) {
    put(name + '.cnf', `[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=${hostname}\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname}\n`);
    openssl('req', '-new', '-key', 'leaf.key', '-out', name + '.csr', '-config', name + '.cnf');
    openssl('ca', '-batch', '-notext', '-config', 'sign.cnf', '-in', name + '.csr', '-out', name + '.pem',
      '-extfile', name + '.cnf', '-extensions', 'server',
      ...(name === 'expired' ? ['-startdate', '20200101000000Z', '-enddate', '20200102000000Z'] : ['-days', '1']));
  }
  const read = (name: string) => readFileSync(join(certificateRoot, name));
  certificates = { ca: join(certificateRoot, 'ca.pem'), wrongCA: join(certificateRoot, 'wrong-ca.pem'),
    key: read('leaf.key'), valid: read('valid.pem'), wrongHost: read('wrong-host.pem'), expired: read('expired.pem') };
  assert.ok(new X509Certificate(read('ca.pem')).ca);
  assert.equal(new X509Certificate(certificates.valid).checkHost('staging.example.invalid'), 'staging.example.invalid');
  assert.equal(new X509Certificate(certificates.wrongHost).checkHost('staging.example.invalid'), undefined);
  assert.ok(Date.parse(new X509Certificate(certificates.expired).validTo) < Date.now());
});
after(() => {
  if (!certificateRoot) return;
  // Use the host rm guard, including for these disposable keys.
  const result = spawnSync('rm', ['-R', '-f', '--', certificateRoot], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(certificateRoot), false);
});

// Run the CLI against private synthetic profiles and stubbed dist dependencies.
// Protocol cases stub TLS/HTTPS; trust cases use the real pinned TLS transport.
async function exercise(config: Record<string, unknown> = {}) {
  const prefix = 'commonswarm-box-dry-run-allow-proof-';
  const root = createTemporary(join(realpathSync(tmpdir()), prefix));
  try {
    for (const dir of ['scripts', 'dist/cloud', 'human', 'seat']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
    const write = (path: string, contents: string) => writeFileSync(join(root, path), contents, { mode: 0o600 });
    copyFileSync('scripts/staging-allow-proof.mjs', join(root, 'scripts/staging-allow-proof.mjs'));
    if (config.realTLS) {
      // Fixture-only address substitution: no CLI flag, environment variable or
      // production export can reach this seam. The production CLI's rejection of
      // loopback remains covered below. TLS, SNI and peer checks stay unmodified.
      const script = join(root, 'scripts/staging-allow-proof.mjs');
      const source = readFileSync(script, 'utf8');
      const pin = "staging: '157.90.159.116'";
      assert.equal(source.split(pin).length, 2, 'exactly one reviewed staging address');
      writeFileSync(script, source.replace(pin, "staging: '127.0.0.1'"));
    }
    const ca = config.ca ?? certificates.ca;
    const caBytes = config.caContents ?? readFileSync(String(ca), 'utf8');
    // A deliberately contaminated CA input stays with the disposable keys.
    const caPath = config.caContents ? join(certificateRoot, 'supplied-ca.pem') : join(root, 'ca.pem');
    writeFileSync(caPath, String(caBytes), { mode: 0o600 });
    write('package.json', '{"type":"module"}');
    write('human/target.json', JSON.stringify({ url: config.target ?? origin, anon_key: 'fixture-anon-do-not-print' }));
    if (config.malformedTarget) write('human/target.json', '{"anon_key":"fixture-anon-do-not-print" broken}');
    write('seat/profile.json', JSON.stringify({ url: config.seatTarget ?? origin, workspace_id: workspace, principal_id: principal }));
    if (config.malformedSeat) write('seat/profile.json', '{"anon_key":"fixture-anon-do-not-print" broken}');
    write('dist/cloud/config.js', `
      export const CLIENT_PROTOCOL_VERSION = '0.1.0';
      export const cloudTarget = (url, anonKey) => ({ url: new URL(url).origin, anonKey });
      export const commandEndpoint = target => target.url + '/functions/v1/command';
    `);
    write('dist/cloud/client-build.js', 'export const withClientBuild = value => value;');
    write('dist/cloud/storage.js', 'export const credentialStore = async () => ({});');
    write('dist/cloud/auth.js', `
      export async function refreshedCredential() {
        const config = JSON.parse(process.env.ALLOW_CONFIG);
        const r = await fetch(config.refreshTarget ?? (config.target ?? ${JSON.stringify(origin)}) + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', headers: { authorization: 'Bearer fixture-human-do-not-print' },
          body: JSON.stringify({ refresh_token: 'fixture-refresh-do-not-print' }) });
        if (!r.ok || config.authThrows) throw new Error('fixture-human-do-not-print');
        return { accessToken: 'fixture-human-do-not-print', refreshToken: 'fixture-refresh-do-not-print' };
      }
    `);
    write('dist/cloud/agent-profile.js', `
      import { readFile } from 'node:fs/promises';
      export const readAgentProfile = async path => JSON.parse(await readFile(path, 'utf8'));
      export const readProfileCredential = async () => ({ token: JSON.parse(process.env.ALLOW_CONFIG).agentToken ?? 'fixture-agent-do-not-print' });
    `);
    write('trace.txt', '');
    write('transport.mjs', `
      import assert from 'node:assert/strict';
      import { appendFileSync } from 'node:fs';
      import { EventEmitter } from 'node:events';
      import https from 'node:https';
      import tls from 'node:tls';
      import { syncBuiltinESMExports } from 'node:module';
      const config = JSON.parse(process.env.ALLOW_CONFIG);
      let reads = 0, lists = 0, sockets = 0;
      tls.connect = options => {
        assert.equal(options.host, ${JSON.stringify(stagingAddress)});
        assert.equal(options.servername, new URL(config.target ?? ${JSON.stringify(origin)}).hostname);
        assert.equal(options.rejectUnauthorized, true);
        const socket = new EventEmitter();
        socket.remoteAddress = (++sockets === config.wrongPeerAt ? '100.115.66.74' : config.remoteAddress) ?? ${JSON.stringify(stagingAddress)};
        socket.authorized = config.authorized ?? true;
        socket.destroy = () => {};
        queueMicrotask(() => socket.emit('secureConnect'));
        return socket;
      };
      https.request = (url, options, receive) => {
        assert.equal(new URL(url).origin, config.target ?? ${JSON.stringify(origin)});
        const req = new EventEmitter();
        req.end = payload => options.agent.createConnection({ port: new URL(url).port || 443 }, (err, socket) => {
          if (err) { req.emit('error', err); return; }
          // This callback is the point at which Node may send HTTP bytes.
          let http = 200, body;
          if (new URL(url).pathname === '/auth/v1/token') {
            appendFileSync(process.env.ALLOW_TRACE, 'refresh\\n');
            body = { access_token: 'fixture-human-do-not-print', refresh_token: 'fixture-refresh-do-not-print' };
          } else {
            const command = JSON.parse(payload).command;
            appendFileSync(process.env.ALLOW_TRACE, command.kind + '\\n');
            const local = { kind: 'local', principal_id: ${JSON.stringify(principal)},
              connection_id: '33333333-3333-4333-8333-333333333333',
              grant_id: '44444444-4444-4444-8444-444444444444',
              approval: lists === 0 ? null : { expires_at: null,
                operations: ['read'], ...(config.untrustedFields ? { extra: 'fixture-agent-do-not-print' } : {}) },
              effective_access: { source: config.accessSource ?? 'explicit', operations: ['read'],
                ...(config.untrustedFields ? { extra: 'fixture-human-do-not-print' } : {}) } };
            if (command.kind === 'household_tool') {
              if (reads++ === 0) {
                http = config.initialHttp ?? 200;
                body = { status: config.initialStatus ?? 'refused', reason: config.initialReason ?? 'workspace_access_refused' };
              } else body = { status: config.postReadStatus ?? 'ok' };
            } else if (command.kind === 'household_connections') {
              const failed = config.listFailure === ++lists;
              if (config.listThrows === lists) { req.emit('error', new Error('fixture-agent-do-not-print')); return; }
              body = { status: failed ? 'refused' : 'ok', connections: [local] };
              if (failed) http = config.listHttp ?? 500;
              if (config.malformedList === lists) delete body.connections;
            } else if (command.kind === 'household_permissions') body = { status: config.allowStatus ?? 'committed' };
            else assert.fail('unexpected command');
          }
          const response = new EventEmitter();
          response.statusCode = config.redirect ? 302 : http;
          response.resume = () => {};
          receive(response);
          response.emit('data', JSON.stringify(body));
          response.emit('end');
        });
        return req;
      };
      // Baseline controls must remain offline even if the owner regresses to fetch.
      globalThis.fetch = async (input, init = {}) => new Promise((resolve, reject) => {
        const req = https.request(new URL(input), {
          agent: { createConnection: (_options, cb) => cb(null, {}) },
        }, response => {
          let body = '';
          response.on('data', chunk => body += chunk);
          response.on('end', () => resolve(new Response(body, { status: response.statusCode })));
        });
        req.once('error', reject);
        req.end(init.body);
      });
      syncBuiltinESMExports();
    `);
    const args = [...(config.realTLS ? [] : ['--import', join(root, 'transport.mjs')]), join(root, 'scripts/staging-allow-proof.mjs'),
      '--human-profile', join(root, 'human'), '--seat-profile', join(root, 'seat'), '--workspace-id', workspace];
    if (!config.noExpectedArg && !config.expectedEnv) args.push('--expected-staging-origin', String(config.expected ?? origin));
    if (!config.noAddress) args.push('--staging-address', String(config.address ?? stagingAddress));
    if (!config.noCA) args.push('--staging-ca', caPath);
    if (!config.noCADigest) args.push('--staging-ca-sha256', String(config.caDigest ?? createHash('sha256').update(String(caBytes)).digest('hex')));
    args.push('--out', join(root, 'report.json'));
    const { caContents: _caContents, ...transportConfig } = config;
    const env: NodeJS.ProcessEnv = { ...process.env, ALLOW_TRACE: join(root, 'trace.txt'), ALLOW_CONFIG: JSON.stringify(transportConfig) };
    if (config.extraCA) env.NODE_EXTRA_CA_CERTS = String(config.extraCA);
    delete env.COMMONSWARM_EXPECTED_STAGING_ORIGIN;
    if (config.expectedEnv) env.COMMONSWARM_EXPECTED_STAGING_ORIGIN = String(config.expectedEnv);
    // An async child lets the test's real local HTTPS server service handshakes.
    const child = spawn(process.execPath, args, { env, timeout: 10_000 });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    const [status, signal] = await once(child, 'close');
    const result = { stdout, stderr, status, signal };
    const outputFile = existsSync(join(root, 'report.json')) ? readFileSync(join(root, 'report.json'), 'utf8') : '';
    const allOutput = result.stdout + result.stderr + outputFile;
    assert.doesNotMatch(allOutput, /-----BEGIN [^-]*PRIVATE KEY-----/);
    assert.equal(/fixture-(?:human|agent|anon|refresh)-do-not-print/.test(allOutput), false, 'synthetic credential appeared in output');
    if (config.agentToken) assert.equal(allOutput.includes(String(config.agentToken)), false);
    assert.ok(outputFile, 'success and failure both write a private report');
    return { ...result, outputFile, trace: readFileSync(join(root, 'trace.txt'), 'utf8').trim().split('\n').filter(Boolean),
      report: result.stdout ? JSON.parse(result.stdout) : null };
  } finally { removeTemporary(root, prefix); }
}

test('staging Allow proof passes only after initial denial, successful lists and post-Allow checks', async () => {
  for (const config of [{}, { expectedEnv: origin }]) {
    const result = await exercise(config);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.report.verdict, 'PASS');
    assert.deepEqual(result.report.failed_conditions, []);
    assert.equal(result.trace.filter(kind => kind === 'household_permissions').length, 3);
    assert.equal(result.report.database_checks.filter((line: string) => line.startsWith('SELECT')).length, 3);
  }
});

test('staging Allow proof refuses a pre-allowed agent or unrelated initial error before Allow', async () => {
  for (const config of [
    { initialStatus: 'ok' },
    { initialHttp: 503, initialReason: 'service_unavailable' },
    { initialHttp: 403, initialReason: 'workspace_access_refused' },
    { initialReason: 'content_consent_required' },
  ]) {
    const result = await exercise(config);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.report.verdict, /FAIL: initial agent read/);
    assert.deepEqual(result.trace, ['refresh', 'household_tool']);
  }
});

test('staging Allow proof requires every connection-list response to succeed', async () => {
  for (const listFailure of [1, 2]) for (const listHttp of [200, 500]) {
    const result = await exercise({ listFailure, listHttp });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.report.verdict, listFailure === 1 ? /FAIL: initial connection-list/ : /FAIL: final_connection_list/);
    if (listFailure === 1) assert.equal(result.trace.includes('household_permissions'), false);
  }
  for (const field of ['malformedList', 'listThrows']) for (const index of [1, 2]) {
    const result = await exercise({ [field]: index });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.report.verdict, /connection.list/);
  }
});

test('staging Allow proof refuses wrong or absent staging origin before refresh or any request', async () => {
  for (const config of [
    { target: 'https://production.example.invalid' },
    { seatTarget: 'https://production.example.invalid' },
    { target: 'https://staging.example.invalid.attacker.invalid' },
    { target: 'https://staging.example.invalid:8443' },
    { target: origin + '/path' },
    { expected: origin + '/path' },
    { noExpectedArg: true },
  ]) {
    const result = await exercise(config);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /FAIL:.*(?:staging|origin)/);
    assert.deepEqual(result.trace, []);
  }
});

test('staging Allow proof refuses a refresh request outside the approved origin', async () => {
  const result = await exercise({ refreshTarget: 'https://production.example.invalid/auth/v1/token' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /FAIL: request URL differs from expected staging origin/);
  assert.deepEqual(result.trace, []);
});

test('staging Allow proof names failed post-Allow conditions', async () => {
  for (const [config, condition] of [
    [{ allowStatus: 'refused' }, 'single_allow_committed'],
    [{ postReadStatus: 'refused' }, 'read_after_single'],
  ] as const) {
    const result = await exercise(config);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.report.failed_conditions.includes(condition));
    assert.match(result.report.verdict, new RegExp(condition));
  }
});


test('staging Allow proof binds matching production hostnames to the reviewed staging transport before refresh', async () => {
  const production = 'https://api.commonswarm.com';
  for (const config of [
    { noAddress: true }, { address: '100.115.66.74' }, { address: '178.105.29.28' },
    { address: '127.0.0.1' }, { address: '::ffff:157.90.159.116' },
  ]) {
    const result = await exercise({ expected: production, target: production, seatTarget: production, ...config });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /reviewed c1-staging address/);
    assert.deepEqual(result.trace, [], 'must refuse before credential refresh');
  }
  const happy = await exercise({ expected: production, target: production, seatTarget: production, address: stagingAddress });
  assert.equal(happy.status, 0, happy.stderr);
  assert.equal(happy.report.verdict, 'PASS');
  assert.equal(happy.trace[0], 'refresh');
  for (const config of [{ remoteAddress: '100.115.66.74' }, { remoteAddress: '178.105.29.28' },
    { remoteAddress: '127.0.0.1' }, { authorized: false }]) {
    const result = await exercise(config);
    assert.equal(result.status, 1);
    assert.deepEqual(result.trace, [], 'no HTTP bytes before peer address and certificate validation');
  }
  const laterPeer = await exercise({ wrongPeerAt: 2 });
  assert.equal(laterPeer.status, 1);
  assert.deepEqual(laterPeer.trace, ['refresh'], 'every later connection must also validate its peer');
});

test('staging Allow proof never serializes echoed credentials, unknown fields or private JSON errors', async () => {
  for (const config of [
    { initialReason: 'fixture-agent-do-not-print' },
    { initialStatus: 'fixture-human-do-not-print' },
    { malformedTarget: true },
    { malformedSeat: true },
    { authThrows: true },
    { accessSource: 'fixture-anon-do-not-print', untrustedFields: true },
    // Valid UUID fields and generated SQL also pass through final redaction.
    { agentToken: '33333333-3333-4333-8333-333333333333' },
  ]) {
    const result = await exercise(config);
    if (config.initialReason) assert.equal(result.report.steps.agent_read_before.reason, 'unrecognized_response');
    if (config.initialStatus) assert.equal(result.report.steps.agent_read_before.status, 'unrecognized_response');
    if (config.malformedTarget) {
      assert.equal(result.status, 1);
      assert.equal(result.report.reason, 'private_json_invalid');
      assert.deepEqual(result.trace, []);
    }
    if (config.malformedSeat || config.authThrows) {
      assert.equal(result.status, 1);
      assert.equal(result.report.reason, 'proof_failed');
    }
    assert.equal(result.stdout, result.outputFile);
    assert.doesNotMatch(result.stderr, /SyntaxError|Error:| at /);
  }
});

test('staging Allow proof refuses redirects without forwarding credentials', async () => {
  const result = await exercise({ redirect: true });
  assert.equal(result.status, 1);
  assert.deepEqual(result.trace, ['refresh']);
});

test('staging Allow proof requires reviewed public CA bytes before profiles or transport', async () => {
  for (const [config, reason] of [
    [{ noCA: true }, '--staging-ca is required'],
    [{ noCADigest: true }, '--staging-ca-sha256 must be a SHA-256 hex digest'],
    [{ caDigest: 'not-hex' }, '--staging-ca-sha256 must be a SHA-256 hex digest'],
    [{ caDigest: '0'.repeat(64) }, 'staging CA digest mismatch; no requests sent'],
    [{ caContents: readFileSync(certificates.ca, 'utf8') + certificates.key.toString() }, 'staging CA must contain only a public PEM certificate'],
    [{ caContents: 'invalid PEM' }, 'staging CA must contain only a public PEM certificate'],
    [{ caContents: certificates.valid.toString() }, 'staging CA certificate required'],
  ] as const) {
    // An invalid profile would fail differently if CA admission moved later.
    const result = await exercise({ ...config, malformedTarget: true });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.report.reason, reason);
    assert.deepEqual(result.trace, []);
  }
});

test('staging Allow proof verifies private CA, hostname and expiry on real pinned TLS before HTTP', async t => {
  for (const [name, cert, config, pass, beforeTLS] of [
    ['reviewed CA and valid hostname', 'valid', {}, true, false],
    // Even a trusted issuer in NODE_EXTRA_CA_CERTS cannot augment the supplied CA.
    ['wrong CA despite NODE_EXTRA_CA_CERTS', 'valid', { ca: certificates.wrongCA, extraCA: certificates.ca }, false, false],
    ['wrong hostname', 'wrongHost', {}, false, false],
    ['expired leaf', 'expired', {}, false, false],
    ['CA digest mismatch', 'valid', { caDigest: '0'.repeat(64) }, false, true],
    ['private key in CA file', 'valid', { caContents: readFileSync(certificates.ca, 'utf8') + certificates.key.toString() }, false, true],
  ] as const) await t.test(name, async () => {
    let requests = 0, connections = 0, reads = 0, lists = 0, allows = 0;
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer({ key: certificates.key, cert: certificates[cert] });
    server.on('connection', socket => { connections++; sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('tlsClientError', () => { /* expected certificate refusals */ });
    server.on('request', async (req, res) => {
      requests++;
      let payload = '';
      for await (const chunk of req) payload += chunk;
      let body;
      if (req.url?.startsWith('/auth/v1/token')) {
        body = { access_token: 'fixture-human-do-not-print', refresh_token: 'fixture-refresh-do-not-print' };
      } else {
        const { command } = JSON.parse(payload);
        if (command.kind === 'household_tool') body = reads++ === 0
          ? { status: 'refused', reason: 'workspace_access_refused' } : { status: 'ok' };
        else if (command.kind === 'household_permissions') { allows++; body = { status: 'committed' }; }
        else if (command.kind === 'household_connections') body = { status: 'ok', connections: [{ kind: 'local', principal_id: principal,
          connection_id: '33333333-3333-4333-8333-333333333333', grant_id: '44444444-4444-4444-8444-444444444444',
          approval: lists++ === 0 ? null : { expires_at: null, operations: ['read'] },
          effective_access: { source: 'explicit', operations: ['read'] } }] };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const target = `${origin}:${address.port}`;
      const result = await exercise({ realTLS: true, target, expected: target, seatTarget: target, address: '127.0.0.1', ...config });
      assert.equal(result.status, pass ? 0 : 1, result.stderr);
      if (pass) {
        assert.equal(result.report.verdict, 'PASS');
        assert.equal(allows, 3);
        assert.equal(requests, 9, 'refresh and every proof command used real HTTPS');
        assert.equal(result.report.staging_ca_sha256, createHash('sha256').update(readFileSync(certificates.ca)).digest('hex'));
      } else {
        assert.equal(requests, 0, 'no HTTP request or credential before TLS trust validation');
        if (beforeTLS) assert.equal(connections, 0, 'CA input must be admitted before opening a socket');
        else assert.ok(connections > 0, 'negative must reach the real TLS handshake');
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

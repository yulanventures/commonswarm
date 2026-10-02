import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
// Standalone Node tool intentionally has no TypeScript/dependency requirement.
// @ts-ignore No declaration file for the standalone .mjs script.
import { pkceChallenge, redactedReceipt, callbackCode } from '../../scripts/dcr-roundtrip.mjs';

test('PKCE S256 matches RFC 7636 appendix B, with changed-verifier control', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.equal(pkceChallenge(verifier), challenge);
  assert.notEqual(pkceChallenge(`${verifier}x`), challenge);
});

test('receipt retains evidence but excludes secrets and hostile metadata values', () => {
  const token = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.fake_signature';
  const input = {
    ok: true,
    requests: { token: { status: 200, content_type: 'application/json; charset=utf-8' } },
    clientId: 'abcdefgh123456789012345678901234',
    token: { access_token: token, refresh_token: token, id_token: token,
      token_type: 'Bearer', expires_in: 300, scope: 'mcp' },
    code: token, verifier: token, toolCount: 8, serverName: 'commonswarm',
    unknown: { nested: token },
  };
  const safe = redactedReceipt(input);
  assert.deepEqual(safe, {
    ok: true, requests: { token: { status: 200, content_type: 'application/json' } },
    client_id_prefix: 'abcdefgh', token_type: 'Bearer', expires_in: 300,
    scope: 'mcp', tool_count: 8, mcp_server_name: 'commonswarm',
  });
  const output = JSON.stringify(safe);
  assert.ok(!output.includes(token));
  assert.ok(!output.includes(input.clientId));
  const hostile = JSON.stringify(redactedReceipt({ ...input, serverName: token,
    clientId: token, token: { ...input.token, scope: token, token_type: token },
    requests: { token: { status: 401, content_type: token }, [token]: { status: 200 } },
  }));
  assert.ok(!hostile.includes(token));
  assert.match(hostile, /"status":401/u);
});

test('full callback verifies state, destination and optional issuer before returning code', () => {
  const base = 'https://dcr-release-probe.invalid/callback';
  const good = `${base}?state=expected&code=synthetic-code&iss=https%3A%2F%2Fmcp.commonswarm.com`;
  assert.equal(callbackCode(good, 'expected'), 'synthetic-code');
  assert.throws(() => callbackCode(good, 'wrong'), /state_mismatch/u);
  assert.throws(() => callbackCode(`${good}&state=expected`, 'expected'), /state_mismatch/u);
  assert.throws(() => callbackCode(good.replace('dcr-release-probe.invalid', 'other.invalid'), 'expected'), /wrong_callback/u);
  assert.throws(() => callbackCode(good.replace('mcp.commonswarm.com', 'other.invalid'), 'expected'), /issuer_mismatch/u);
  assert.throws(() => callbackCode(`${base}?state=expected&error=access_denied`, 'expected'), /consent_refused/u);
  assert.throws(() => callbackCode('synthetic-code', 'expected'), /invalid_callback_url/u);
});

test('CLI dry run emits planned requests and cannot call fetch', () => {
  const script = fileURLToPath(new URL('../../scripts/dcr-roundtrip.mjs', import.meta.url));
  // A throwing fetch is installed before the actual entry point. Any accidental
  // network call fails this invocation rather than contacting a service.
  const preload = 'data:text/javascript,' + encodeURIComponent(
    "globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };"
  );
  const run = spawnSync(process.execPath, ['--import', preload, script, '--dry-run'], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const plan = JSON.parse(run.stdout);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.user_agent, 'curl/8.7.1');
  assert.equal(plan.request_timeout_ms, 10000);
  const registration = plan.requests.find((row: { body?: { redirect_uris?: string[] } }) => row.body?.redirect_uris);
  assert.deepEqual(registration.body, {
    redirect_uris: ['https://dcr-release-probe.invalid/callback'],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
  });
  const human = plan.requests.find((row: { method: string }) => row.method === 'GET (human)');
  const url = new URL(human.url);
  assert.equal(url.searchParams.get('scope'), 'mcp');
  assert.equal(url.searchParams.get('resource'), 'https://mcp.commonswarm.com/mcp');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.has('state'));
  assert.deepEqual(plan.requests.slice(-3).map((row: { rpc: string }) => row.rpc),
    ['initialize', 'notifications/initialized', 'tools/list']);
  // Positive entry-point control: an invalid option must hit usage and fail.
  const invalid = spawnSync(process.execPath, ['--import', preload, script, '--not-an-option'], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Usage:/u);
  assert.equal(invalid.stdout, '');
});

for (const outcome of ['success', 'invalid_callback', 'cancelled', 'token_failure'] as const) {
  test(`CLI exits after ${outcome} with its callback pipe left open`, async () => {
    const script = fileURLToPath(new URL('../../scripts/dcr-roundtrip.mjs', import.meta.url));
    // Replace fetch before executing the real CLI; no service or production hook.
    const preload = 'data:text/javascript,' + encodeURIComponent(`
      globalThis.fetch = async (url, options) => {
        const issuer = 'https://mcp.commonswarm.com';
        let body, status = 200;
        switch (String(url)) {
          case issuer + '/.well-known/oauth-authorization-server':
            body = { issuer, registration_endpoint: issuer + '/register',
              authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
              code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp'] };
            break;
          case issuer + '/.well-known/oauth-protected-resource/mcp':
            body = { resource: issuer + '/mcp', authorization_servers: [issuer], scopes_supported: ['mcp'] };
            break;
          case issuer + '/register':
            status = 201;
            body = { client_id: 'synthetic-client-1234567890123456', token_endpoint_auth_method: 'none',
              redirect_uris: ['https://dcr-release-probe.invalid/callback'] };
            break;
          case issuer + '/token':
            if (${JSON.stringify(outcome)} === 'token_failure') throw new Error('synthetic-private-error');
            body = { access_token: 'synthetic-private-token', token_type: 'Bearer', expires_in: 300, scope: 'mcp' };
            break;
          case issuer + '/mcp': {
            const rpc = JSON.parse(options.body);
            switch (rpc.method) {
              case 'initialize':
                body = { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18',
                  serverInfo: { name: 'commonswarm' } } };
                break;
              case 'notifications/initialized': return new Response(null, { status: 202 });
              case 'tools/list': body = { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'claim_seat' }] } }; break;
              default: throw new Error('unexpected_stub_rpc');
            }
            break;
          }
          default: throw new Error('unexpected_stub_url');
        }
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      };
    `);
    const child = spawn(process.execPath, ['--import', preload, script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', sent = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 3000);
    try {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        const newline = stdout.indexOf('\n');
        if (sent || newline < 0) return;
        sent = true;
        const authorization = new URL(stdout.slice(0, newline));
        const callback = new URL(authorization.searchParams.get('redirect_uri')!);
        callback.searchParams.set('state', authorization.searchParams.get('state')!);
        callback.searchParams.set('code', 'synthetic-private-code');
        const line = outcome === 'invalid_callback' ? 'synthetic-private-invalid-url\n'
          : outcome === 'cancelled' ? '\u0003' : `${callback.href}\n`;
        child.stdin.write(line); // Deliberately never end the pipe.
      });
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve([code, signal]));
      });
      assert.ok(sent, 'CLI must reach consent input');
      const receipt = JSON.parse(stdout.slice(stdout.indexOf('\n') + 1));
      assert.equal(receipt.ok, outcome === 'success', 'CLI must print its final receipt');
      assert.equal(timedOut, false, 'CLI printed its receipt but kept the callback pipe alive');
      assert.equal(signal, null);
      assert.equal(code, outcome === 'success' ? 0 : 1);
      if (outcome === 'success') {
        assert.equal(receipt.tool_count, 1);
        assert.equal(receipt.requests.tools_list.status, 200);
      } else {
        const reason = outcome === 'token_failure' ? 'request_or_runtime_failed'
          : outcome === 'invalid_callback' ? 'invalid_callback_url' : 'cancelled';
        assert.ok(stderr.includes(reason), 'failure must have a safe reason');
      }
      for (const privateValue of ['synthetic-private-token', 'synthetic-private-code',
        'synthetic-private-invalid-url', 'synthetic-private-error']) {
        assert.ok(!(stdout + stderr).includes(privateValue), 'CLI must not print private input or remote errors');
      }
    } finally {
      clearTimeout(timer);
      child.kill('SIGKILL');
      child.stdin.destroy();
    }
  });
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const dist = new URL('../dist/oauth/c1-controls/', import.meta.url);

test('ordinary controls built CIMD metadata is public, refreshable and limited to the ordinary resource', async () => {
  assert.deepEqual(JSON.parse(await readFile(new URL('client.json', dist))), {
    client_id: 'https://commonswarm.com/oauth/c1-controls/client.json',
    client_name: 'CommonSwarm C1 ordinary controls', client_uri: 'https://commonswarm.com', application_type: 'web',
    redirect_uris: ['https://commonswarm.com/oauth/c1-controls/callback'], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access mcp',
  });
});

test('ordinary controls callback has no executable content or outbound handoff', async () => {
  const html = await readFile(new URL('callback/index.html', dist), 'utf8');
  assert.doesNotMatch(html, /<(?:script|a|link|iframe|embed|object|form|img|style)\b/i);
  assert.doesNotMatch(html, /\b(?:src|href|action|on\w+)\s*=/i);
  assert.match(html, /name="robots" content="noindex"/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.doesNotMatch(html, /http-equiv/i);
  assert.equal(html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)[1].replace(/<[^>]*>/g, '').trim(),
    'Copy the full address of this page and give it to the release worker. Do not share it with anyone else.');
});

// Test-process preload only: send the executable's pinned public requests to
// a local fake AS/MCP. Preserve the canonical URI in its actual DPoP proof.
// Reject every other URL before fetch; no production seam in the runner.
import { lstatSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, sep } from 'node:path';

const originalFetch = globalThis.fetch;
const origin = new URL(process.env.ADMIN_SMOKE_FIXTURE_ORIGIN);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/' || !origin.port) {
  throw new Error('invalid_fixture_origin');
}
// Portable secret-window parent for tests on any OS. The executable keeps
// /private/tmp unless this test-only preload is imported. The parent must be
// a real 0700 directory owned by this user under the OS temporary root and
// never under the home directory.
const secretRoot = process.env.ADMIN_SMOKE_SECRET_ROOT;
if (secretRoot !== undefined) {
  const temporary = realpathSync(tmpdir()), home = realpathSync(homedir());
  const stat = lstatSync(secretRoot);
  if (!isAbsolute(secretRoot) || realpathSync(secretRoot) !== secretRoot || !stat.isDirectory() ||
    stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700 ||
    !secretRoot.startsWith(temporary + sep) || secretRoot === home || secretRoot.startsWith(home + sep)) {
    throw new Error('invalid_fixture_secret_root');
  }
  globalThis[Symbol.for('commonswarm.admin-smoke.secret-root')] = secretRoot;
}
globalThis.fetch = (input, options) => {
  const url = new URL(input);
  if (!['https://mcp.commonswarm.com', 'https://api.commonswarm.com'].includes(url.origin)) {
    throw new Error('network_forbidden');
  }
  return originalFetch(new URL(url.pathname + url.search, origin), options);
};

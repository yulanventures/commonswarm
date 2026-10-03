// Test-process preload only: send the executable's pinned public requests to
// a local fake AS/MCP. Preserve the canonical URI in its actual DPoP proof.
// Reject every other URL before fetch; no production seam in the runner.
const originalFetch = globalThis.fetch;
const origin = new URL(process.env.ADMIN_SMOKE_FIXTURE_ORIGIN);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/' || !origin.port) {
  throw new Error('invalid_fixture_origin');
}
globalThis.fetch = (input, options) => {
  const url = new URL(input);
  if (!['https://mcp.commonswarm.com', 'https://api.commonswarm.com'].includes(url.origin)) {
    throw new Error('network_forbidden');
  }
  return originalFetch(new URL(url.pathname + url.search, origin), options);
};

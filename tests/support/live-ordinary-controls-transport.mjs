// Test preload only. The real executable has no fixture flag/env/global seam.
// Reject all external traffic before fetch; keep protocol URIs unchanged.
const rawFetch = globalThis.fetch;
const origin = new URL(process.env.LIVE_CONTROLS_FIXTURE_ORIGIN);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/') throw new Error('invalid_fixture_origin');
globalThis.fetch = (input, init) => {
  const u = new URL(input);
  if (!['https://mcp.commonswarm.com', 'https://api.commonswarm.com', 'https://commonswarm.com'].includes(u.origin)) throw new Error('external_network_refused');
  return rawFetch(new URL(u.pathname + u.search, origin), init);
};

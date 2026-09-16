import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const path = process.argv[2];
const trustMode = process.argv[3] ?? "with-trusted-proxies";
if (!path) {
  throw new Error(
    "usage: node check-caddy-adapted.mjs <adapted-json> " +
      "[with-trusted-proxies|without-trusted-proxies]",
  );
}
assert.ok(
  trustMode === "with-trusted-proxies" ||
    trustMode === "without-trusted-proxies",
);

const config = JSON.parse(await readFile(path, "utf8"));
const servers = Object.values(config.apps?.http?.servers ?? {});
assert.equal(servers.length, 1);
const server = servers[0];

const cloudflareRanges = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];
if (trustMode === "with-trusted-proxies") {
  assert.equal(server.trusted_proxies?.source, "static");
  assert.deepEqual(server.trusted_proxies?.ranges, cloudflareRanges);
  assert.equal(server.trusted_proxies_strict, 1);
  assert.deepEqual(server.client_ip_headers, [
    "CF-Connecting-IP",
    "X-Forwarded-For",
  ]);
} else {
  assert.equal(server.trusted_proxies, undefined);
  assert.equal(server.trusted_proxies_strict, undefined);
  assert.equal(server.client_ip_headers, undefined);
}

const proxies = [];
function collect(value) {
  if (value === null || typeof value !== "object") return;
  if (value.handler === "reverse_proxy") proxies.push(value);
  for (const child of Object.values(value)) collect(child);
}
collect(server.routes);

const projectHost = "ukezjcnxjvkpkeezxaew.supabase.co";
const projectProxies = proxies.filter(
  (proxy) => proxy.upstreams?.[0]?.dial === `${projectHost}:443`,
);
const localProxies = proxies.filter(
  (proxy) => proxy.upstreams?.[0]?.dial === "127.0.0.1:9000",
);
assert.equal(projectProxies.length, 5);
assert.equal(localProxies.length, 1);

const supabaseDeletedHeaders = [
  "CF-Connecting-IP",
  "CF-Ray",
  "CF-Visitor",
  "CF-IPCountry",
  "CDN-Loop",
  "True-Client-IP",
];

for (const proxy of projectProxies) {
  const requestHeaders = proxy.headers?.request;
  assert.deepEqual(requestHeaders?.delete, supabaseDeletedHeaders);
  assert.deepEqual(requestHeaders?.set?.Host, [projectHost]);
  assert.deepEqual(requestHeaders?.set?.["X-Forwarded-Host"], [projectHost]);
  assert.deepEqual(requestHeaders?.set?.["X-Forwarded-Proto"], ["https"]);
  assert.equal(requestHeaders?.set?.["X-Forwarded-For"], undefined);
}

const realtime = projectProxies.filter(
  (proxy) => proxy.transport?.versions?.length > 0,
);
assert.equal(realtime.length, 1);
assert.deepEqual(realtime[0].transport.versions, ["1.1"]);
assert.equal(realtime[0].flush_interval, -1);

function containsObject(value, target) {
  if (value === target) return true;
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some((child) => containsObject(child, target));
}

const realtimePathMatchers = [];
function collectRealtimePathMatchers(value) {
  if (value === null || typeof value !== "object") return;
  if (
    Array.isArray(value.match) &&
    value.match.some((matcher) => Array.isArray(matcher.path)) &&
    containsObject(value.handle, realtime[0])
  ) {
    for (const matcher of value.match) {
      if (Array.isArray(matcher.path)) {
        realtimePathMatchers.push(...matcher.path);
      }
    }
  }
  for (const child of Object.values(value)) collectRealtimePathMatchers(child);
}
collectRealtimePathMatchers(server.routes);
assert.deepEqual(realtimePathMatchers, ["/realtime/v1", "/realtime/v1/*"]);

const local = localProxies[0];
assert.equal(local.headers?.request?.delete, undefined);
assert.deepEqual(local.headers?.request?.set?.["X-Forwarded-For"], [
  "{http.request.client_ip}",
]);
assert.equal(local.transport?.response_header_timeout, 165_000_000_000);

process.stdout.write(
  `adapted Caddy JSON (${trustMode}): ` +
    `${projectProxies.length} Supabase routes and ` +
    `${localProxies.length} local route verified\n`,
);

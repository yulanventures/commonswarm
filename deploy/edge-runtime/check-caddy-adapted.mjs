import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const path = process.argv[2];
const profile = process.argv[3];
const trustMode = process.argv[4] ?? "with-trusted-proxies";
if (!path || (profile !== "live" && profile !== "maintenance")) {
  throw new Error(
    "usage: node check-caddy-adapted.mjs <adapted-json> " +
      "<live|maintenance> [with-trusted-proxies|without-trusted-proxies]",
  );
}
assert.ok(
  trustMode === "with-trusted-proxies" ||
    trustMode === "without-trusted-proxies",
);

const config = JSON.parse(await readFile(path, "utf8"));
const supabaseHost = collectStrings(config).find((value) =>
  /supabase\.co\b/i.test(value)
);
assert.equal(supabaseHost, undefined, `supabase.co host ${supabaseHost ?? ""}`);

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

const localDials = [
  "127.0.0.1:18001",
  "127.0.0.1:18002",
  "127.0.0.1:18003",
  "127.0.0.1:18004",
  "127.0.0.1:9000",
];

if (profile === "live") {
  const dials = proxyDials(server.routes).sort();
  assert.deepEqual(dials, localDials, "route dials");
  assertProxyDetails(proxiesIn(server.routes));
  assert.equal(originHeaders(server.routes).length, 0, "live route CORS");
  assertErrorCors(server, [
    "api.commonswarm.com",
    "edge-staging.commonswarm.com",
  ]);
} else {
  const publicSite = siteSubroute(server, "api.commonswarm.com");
  const stagingSite = siteSubroute(server, "edge-staging.commonswarm.com");
  assert.deepEqual(proxyDials(publicSite), [], "public upstream");
  assert.deepEqual(proxyDials(stagingSite).sort(), localDials, "route dials");
  assertProxyDetails(proxiesIn(stagingSite));
  assert.equal(originHeaders(stagingSite).length, 0, "staging route CORS");
  assertMaintenanceResponses(publicSite);
  assertErrorCors(server, ["edge-staging.commonswarm.com"]);
}

process.stdout.write(
  `adapted Caddy JSON (${profile}, ${trustMode}) verified\n`,
);

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectStrings(child, out);
    }
  }
  return out;
}

function siteSubroute(server, host) {
  const route = (server.routes ?? []).find((item) =>
    (item.match ?? []).some((matcher) =>
      Array.isArray(matcher.host) && matcher.host.includes(host)
    )
  );
  assert.ok(route, `site ${host}`);
  const subroute = (route.handle ?? []).find((handler) =>
    handler.handler === "subroute"
  );
  assert.ok(subroute, `subroute ${host}`);
  return subroute;
}

function proxiesIn(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (value.handler === "reverse_proxy") out.push(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) proxiesIn(item, out);
    } else proxiesIn(child, out);
  }
  return out;
}

function proxyDials(value) {
  return proxiesIn(value).map((proxy) => proxy.upstreams?.[0]?.dial);
}

function assertProxyDetails(proxies) {
  const functions = proxies.find((proxy) =>
    proxy.upstreams?.[0]?.dial === "127.0.0.1:9000"
  );
  assert.ok(functions, "functions route");
  assert.deepEqual(functions.headers?.request?.set?.["X-Forwarded-For"], [
    "{http.request.client_ip}",
  ]);
  assert.equal(functions.transport?.response_header_timeout, 165_000_000_000);

  const realtime = proxies.find((proxy) =>
    proxy.upstreams?.[0]?.dial === "127.0.0.1:18003"
  );
  assert.ok(realtime, "realtime route");
  assert.deepEqual(realtime.transport?.versions, ["1.1"]);
  assert.equal(realtime.flush_interval, -1);
  assert.deepEqual(realtime.headers?.request?.set?.Host, ["realtime-dev"]);
}

function originHeaders(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (
    value.handler === "headers" &&
    value.response?.set?.["Access-Control-Allow-Origin"]
  ) {
    out.push(value);
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) originHeaders(item, out);
    } else originHeaders(child, out);
  }
  return out;
}

function assertErrorCors(server, hosts) {
  const errorHosts = [];
  const functionErrorPaths = [];
  const errorCorsHandlers = [];
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value.match)) {
      for (const matcher of value.match) {
        if (Array.isArray(matcher.host)) errorHosts.push(...matcher.host);
        if (Array.isArray(matcher.path)) functionErrorPaths.push(...matcher.path);
      }
    }
    if (
      value.handler === "headers" &&
      value.response?.set?.["Access-Control-Allow-Origin"]
    ) {
      errorCorsHandlers.push(value);
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(server.errors);
  assert.deepEqual(errorHosts, hosts);
  assert.deepEqual(functionErrorPaths, ["/functions/v1", "/functions/v1/*"]);
  assert.equal(errorCorsHandlers.length, 1);
  assert.deepEqual(
    errorCorsHandlers[0].response.set["Access-Control-Allow-Origin"],
    ["*"],
  );
}

function assertMaintenanceResponses(publicSite) {
  const responses = [];
  collectResponses(publicSite, [], responses);
  const preflight = responses.filter((item) => item.status === 204);
  const maintenance = responses.filter((item) => item.status === 503);
  assert.deepEqual(
    responses.map((item) => item.status).sort((left, right) => left - right),
    [204, 503],
  );
  assert.equal(preflight.length, 1);
  assert.deepEqual(preflight[0].methods, ["OPTIONS"]);
  assert.equal(maintenance.length, 1);
  assert.deepEqual(maintenance[0].methods, []);
  assert.equal(
    maintenance[0].body,
    '{"error":"maintenance","message":"writes are paused for database migration"}',
  );

  const preflightHeaders = headerMap(routeWithStatus(publicSite, 204));
  assert.deepEqual(preflightHeaders["Access-Control-Allow-Origin"], ["*"]);
  assert.deepEqual(preflightHeaders["Access-Control-Allow-Headers"], [
    "authorization, apikey, content-type, x-client-info",
  ]);
  assert.deepEqual(preflightHeaders["Access-Control-Allow-Methods"], [
    "GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE",
  ]);
  assert.deepEqual(preflightHeaders["Access-Control-Max-Age"], ["300"]);

  const maintenanceHeaders = headerMap(routeWithStatus(publicSite, 503));
  assert.deepEqual(maintenanceHeaders["Access-Control-Allow-Origin"], ["*"]);
  assert.deepEqual(maintenanceHeaders["Cache-Control"], ["no-store"]);
  assert.deepEqual(maintenanceHeaders["Content-Type"], ["application/json"]);
  assert.deepEqual(maintenanceHeaders["Retry-After"], ["300"], "maintenance Retry-After");
}

function collectResponses(value, methods, out) {
  if (!value || typeof value !== "object") return;
  let next = methods;
  if (Array.isArray(value.match)) {
    const named = value.match.flatMap((matcher) => matcher.method ?? []);
    if (named.length > 0) next = named;
  }
  if (value.handler === "static_response") {
    out.push({
      status: value.status_code,
      body: value.body,
      methods: next,
    });
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) collectResponses(item, next, out);
    } else collectResponses(child, next, out);
  }
}

function routeWithStatus(value, status, found = []) {
  if (!value || typeof value !== "object") return found[0];
  if (
    Array.isArray(value.handle) &&
    value.handle.some((handler) =>
      handler.handler === "static_response" && handler.status_code === status
    )
  ) {
    found.push(value);
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) routeWithStatus(item, status, found);
    } else routeWithStatus(child, status, found);
  }
  return found[0];
}

function headerMap(route) {
  const headers = {};
  for (const handler of route?.handle ?? []) {
    if (handler.handler === "headers") {
      Object.assign(headers, handler.response?.set ?? {});
    }
  }
  return headers;
}

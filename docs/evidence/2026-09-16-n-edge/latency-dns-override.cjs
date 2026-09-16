const dns = require("node:dns");
const orig = dns.lookup;
const MAP = { "edge-staging.commonswarm.com": "104.21.79.89" };
dns.lookup = function (host, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  const ip = MAP[host];
  if (ip) { if (opts && opts.all) return process.nextTick(cb, null, [{ address: ip, family: 4 }]); return process.nextTick(cb, null, ip, 4); }
  return orig.call(dns, host, opts, cb);
};

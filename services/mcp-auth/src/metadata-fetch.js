import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const METADATA_BODY_LIMIT_BYTES = 4 * 1024;
export const METADATA_FETCH_TIMEOUT_MS = 100;

function isSpecialUseIpv4(hostname) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [a, b, c] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 31 && c === 196)
    || (a === 192 && b === 52 && c === 193)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 192 && b === 175 && c === 48)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function ipv6Words(hostname) {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;

  const parseHalf = (half) => half === ""
    ? []
    : half.split(":").map((word) => Number.parseInt(word, 16));
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 0 || (halves.length === 1 && zeroCount !== 0)) return undefined;
  return [...left, ...Array(zeroCount).fill(0), ...right];
}

function isIpv4PrefixSpecialUse(high, low) {
  const ipv4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  return isSpecialUseIpv4(ipv4);
}

function isSpecialUseIpv6(hostname) {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const words = ipv6Words(normalized);
  if (!words) return true;

  const expanded = words.map((word) => word.toString(16).padStart(4, "0")).join("");
  const isUnspecified = words.every((word) => word === 0);
  const isLoopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const isIpv4Compatible = words.slice(0, 6).every((word) => word === 0);
  const isIpv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (isUnspecified || isLoopback ||
      ((isIpv4Compatible || isIpv4Mapped) && isIpv4PrefixSpecialUse(words[6], words[7]))) {
    return true;
  }
  // Keep this at least as strict as oidc-provider's own special-use trie. Full
  // transition prefixes are denied regardless of the embedded IPv4 address.
  const specialPrefixes = [
    "0064ff9b0000000000000000", // 64:ff9b::/96
    "0064ff9b0001",             // 64:ff9b:1::/48
    "0100000000000000",         // 100::/64
    "0100000000000001",         // 100::1/64
    "200100",                   // 2001:0000::/24
    "200101",                   // 2001:0100::/24
    "20010db8",                 // 2001:db8::/32
    "2002",                     // 2002::/16
    "2620004f8000",             // 2620:4f:8000::/48
    "3fff0",                    // 3fff::/20
    "5f00",                     // 5f00::/16
    "fc", "fd",                // unique-local space
    "fe8", "fe9", "fea", "feb", // link-local space
    "ff",                       // multicast
  ];
  return specialPrefixes.some((prefix) => expanded.startsWith(prefix));
}

export function addressIsPublic(address) {
  const family = isIP(address.replace(/^\[|\]$/gu, ""));
  return family === 4
    ? !isSpecialUseIpv4(address)
    : family === 6 && !isSpecialUseIpv6(address);
}

export function metadataUrlAllowed(clientId) {
  let url;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }

  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return false;
  }

  switch (isIP(hostname.replace(/^\[|\]$/gu, ""))) {
    case 4:
      return !isSpecialUseIpv4(hostname);
    case 6:
      return !isSpecialUseIpv6(hostname);
    default:
      return true;
  }
}

function timeoutError() {
  return new DOMException("client metadata fetch timed out", "TimeoutError");
}

async function readBodyBeforeDeadline(response, deadline, maximumBufferedBytes) {
  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw timeoutError();
      }

      let timer;
      const result = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeoutError()), remaining);
        }),
      ]).finally(() => clearTimeout(timer));

      if (result.done) {
        break;
      }
      received += result.value.byteLength;
      if (received > maximumBufferedBytes) {
        throw new RangeError("client metadata response exceeds wrapper buffer limit");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

// oidc-provider supplies its own 2.5 second AbortSignal and response-size check.
// This wrapper makes the injected transport testable and applies a stricter,
// whole-body deadline. The larger wrapper buffer leaves the configured 4 KiB
// library limit as the effective metadata-document size cap.
export function createMetadataFetch(fetchImplementation, {
  timeoutMs = METADATA_FETCH_TIMEOUT_MS,
  maximumBufferedBytes = METADATA_BODY_LIMIT_BYTES * 2,
} = {}) {
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("fetchImplementation must be a function");
  }

  return async function fetchMetadata(url, options = {}) {
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);

    try {
      const response = await fetchImplementation(url, {
        ...options,
        signal: controller.signal,
      });
      if (!(response instanceof Response)) {
        throw new TypeError("injected fetch must return a Response");
      }
      return await readBodyBeforeDeadline(response, deadline, maximumBufferedBytes);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  };
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("client metadata fetch aborted", "AbortError");
}

function responseHeaders(headers) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) result.append(name, String(item));
  }
  return result;
}

/**
 * Resolve once, reject if any answer is non-public, and connect to one of the
 * validated addresses while retaining the original hostname for Host, SNI,
 * and certificate verification. The socket never performs a second lookup.
 */
export function createPinnedMetadataFetch({
  lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
  request = httpsRequest,
  connectAndHeadersTimeoutMs = 1_500,
  totalTimeoutMs = 2_500,
  maximumBytes = METADATA_BODY_LIMIT_BYTES,
} = {}) {
  return async function pinnedFetch(input, options = {}) {
    const url = new URL(input);
    if (!metadataUrlAllowed(url.toString())) throw new TypeError("client metadata URL is not public HTTPS");
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    const literalFamily = isIP(hostname);
    let answers;
    if (literalFamily) {
      answers = [{ address: hostname, family: literalFamily }];
    } else {
      let lookupTimer;
      try {
        answers = await Promise.race([
          lookup(hostname),
          new Promise((_, reject) => {
            lookupTimer = setTimeout(() => reject(timeoutError()), connectAndHeadersTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(lookupTimer);
      }
    }
    if (!Array.isArray(answers) || answers.length === 0 ||
        answers.some(({ address }) => !addressIsPublic(address))) {
      throw new TypeError("client metadata DNS did not resolve exclusively to public addresses");
    }
    const selected = answers[0];

    return await new Promise((resolve, reject) => {
      let settled = false;
      let socketRequest;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(totalTimer);
        options.signal?.removeEventListener("abort", onAbort);
        callback(value);
      };
      const totalTimer = setTimeout(
        () => socketRequest?.destroy(timeoutError()),
        totalTimeoutMs,
      );
      const onAbort = () => socketRequest?.destroy(abortError(options.signal));
      const headers = new Headers(options.headers);
      headers.set("host", url.host);
      try {
        socketRequest = request({
          protocol: "https:",
          hostname: selected.address,
          family: selected.family,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: options.method ?? "GET",
          headers: Object.fromEntries(headers),
          servername: hostname,
          rejectUnauthorized: true,
        }, (incoming) => {
          const status = incoming.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            incoming.resume();
            socketRequest.destroy(new TypeError("client metadata redirects are forbidden"));
            return;
          }
          const chunks = [];
          let received = 0;
          incoming.on("data", (chunk) => {
            received += chunk.length;
            if (received > maximumBytes) {
              socketRequest.destroy(new RangeError("client metadata response is too large"));
              return;
            }
            chunks.push(chunk);
          });
          incoming.on("end", () => finish(resolve, new Response(Buffer.concat(chunks), {
            status,
            headers: responseHeaders(incoming.headers),
          })));
        });
      } catch (error) {
        finish(reject, error);
        return;
      }
      socketRequest.setTimeout(connectAndHeadersTimeoutMs, () => socketRequest.destroy(timeoutError()));
      socketRequest.once("error", (error) => finish(reject, error));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      else socketRequest.end();
    });
  };
}

/**
 * Put the validated PostgreSQL cache on oidc-provider's fetch path. Entries are
 * written only after the library validates the complete document in
 * allowClient; an expired entry always falls through to the pinned transport.
 */
export function createPostgresCimdFetch(pool, networkFetch = createPinnedMetadataFetch()) {
  if (!pool || typeof pool.query !== "function" || typeof networkFetch !== "function") {
    throw new TypeError("a PostgreSQL pool and metadata transport are required");
  }
  return async function cachedMetadataFetch(input, options = {}) {
    const clientId = String(input);
    const cached = await pool.query(
      `SELECT metadata,
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - statement_timestamp()))))::int AS max_age
         FROM commonswarm_oauth.cimd_cache
        WHERE client_id = $1 AND expires_at > statement_timestamp()
        LIMIT 1`,
      [clientId],
    );
    if (cached.rowCount === 1) {
      return new Response(JSON.stringify(cached.rows[0].metadata), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": `private, max-age=${cached.rows[0].max_age}`,
        },
      });
    }
    return await networkFetch(input, options);
  };
}

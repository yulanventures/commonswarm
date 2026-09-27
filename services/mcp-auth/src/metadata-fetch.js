import { isIP } from "node:net";

export const METADATA_BODY_LIMIT_BYTES = 4 * 1024;
export const METADATA_FETCH_TIMEOUT_MS = 100;

function isSpecialUseIpv4(hostname) {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
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

  const firstSixAreZero = words.slice(0, 6).every((word) => word === 0);
  const isUnspecified = words.every((word) => word === 0);
  const isLoopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const isUniqueLocal = (words[0] & 0xfe00) === 0xfc00;
  const isLinkLocal = (words[0] & 0xffc0) === 0xfe80;
  const isIpv4Mapped = words.slice(0, 5).every((word) => word === 0)
    && words[5] === 0xffff;
  const isSixToFour = words[0] === 0x2002;
  const isWellKnownNat64 = words[0] === 0x0064
    && words[1] === 0xff9b
    && words.slice(2, 6).every((word) => word === 0);

  return isUnspecified
    || isLoopback
    || isUniqueLocal
    || isLinkLocal
    || ((firstSixAreZero || isIpv4Mapped || isWellKnownNat64)
      && isIpv4PrefixSpecialUse(words[6], words[7]))
    || (isSixToFour && isIpv4PrefixSpecialUse(words[1], words[2]));
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

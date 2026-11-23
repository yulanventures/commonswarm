import net from "node:net";

export interface DatabaseTlsOptions {
  ssl: {
    ca: string;
    rejectUnauthorized: true;
  };
}

/** Add the private CA only when the worker receives one. */
export function withDatabaseTls<T extends Record<string, unknown>>(
  options: T,
  encodedCa: string | undefined,
): T | (T & DatabaseTlsOptions) {
  if (encodedCa === undefined || encodedCa.length === 0) return options;

  let ca: string;
  try {
    ca = atob(encodedCa);
  } catch {
    throw new Error("SWARM_DATABASE_TLS_CA_B64 must be valid base64");
  }
  if (!ca.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("SWARM_DATABASE_TLS_CA_B64 must decode to a PEM certificate");
  }
  return {
    ...options,
    ssl: { ca, rejectUnauthorized: true },
  };
}

export const EDGE_DATABASE_CONNECT_TIMEOUT_SECONDS = 5;
export const EDGE_DATABASE_IDLE_TIMEOUT_SECONDS = 3;
export const EDGE_DATABASE_MAX_LIFETIME_SECONDS = 300;
export const EDGE_DATABASE_KEEP_ALIVE_SECONDS = 5;
export const EDGE_DATABASE_CLOSE_GRACE_MS = 1_000;
export const EDGE_DATABASE_SOCKET_TIMEOUT_MS = 15_000;

export interface EdgeDatabaseConfig {
  /** Maximum per-isolate connections. Keep minimal to avoid exhausting Postgres. */
  max: number;
  /** Idle connection timeout in seconds (default 3). */
  idle_timeout?: number;
  /** TCP + TLS + Postgres startup timeout in seconds (default 5). */
  connect_timeout?: number;
  /** Maximum connection lifetime in seconds before recycling (default 300). */
  max_lifetime?: number;
  /** TCP keep-alive initial delay in seconds (default 5). */
  keep_alive?: number;
  /** Milliseconds after half-close (socket.end) before force-destroying a silent peer (default 1000). */
  close_grace_ms?: number;
  /** Socket inactivity timeout in milliseconds before destroying a dead peer (default 15000). */
  socket_timeout_ms?: number;
}

export interface EdgeDatabaseSocketOptions {
  host: string[];
  port: number[];
  path?: string | false;
  keep_alive?: number | null;
}

export interface EdgeDatabaseResolvedOptions extends Record<string, unknown> {
  max: number;
  prepare: false;
  idle_timeout: number;
  connect_timeout: number;
  max_lifetime: number;
  keep_alive: number;
  backoff: (attemptNum: number) => number;
  socket: (parsedOptions: EdgeDatabaseSocketOptions) => net.Socket;
  ssl?: DatabaseTlsOptions["ssl"];
}

type SocketWithEndpoint = net.Socket & {
  host?: string;
  port?: number;
};

/**
 * Create a postgres.js `socket` factory that:
 * 1. Opens a fresh net.Socket synchronously per connect (fresh OS DNS lookup, never leaks a slot
 *    into postgres.js's `connecting` queue via an async rejection) and records `host`/`port` so
 *    postgres.js's TLS upgrade preserves SNI and certificate hostname verification.
 * 2. Bounds half-closes (`socket.end`, used by postgres.js `terminate()` on `idle_timeout` and
 *    `max_lifetime`) with a grace timer that destroys unresponsive peers instead of wedging the
 *    pool slot in `queues.ended`.
 * 3. Bounds dead/half-open sockets during active queries via `setTimeout`, destroying the socket
 *    without an error argument so postgres.js's `closed(false)` rejects active work with
 *    `CONNECTION_CLOSED` and atomically returns the slot to `queues.closed`.
 *
 * All three hooks live on socket methods (`end`, `destroy`, `emit`) rather than event listeners,
 * so they survive `socket.removeAllListeners()` when postgres.js upgrades to TLS.
 */
export function createEdgeDatabaseSocketFactory(config: {
  closeGraceMs?: number;
  socketTimeoutMs?: number;
} = {}): (parsedOptions: EdgeDatabaseSocketOptions) => net.Socket {
  const closeGraceMs = config.closeGraceMs ?? EDGE_DATABASE_CLOSE_GRACE_MS;
  const socketTimeoutMs = config.socketTimeoutMs ?? EDGE_DATABASE_SOCKET_TIMEOUT_MS;
  let hostIndex = 0;

  return (parsedOptions: EdgeDatabaseSocketOptions): net.Socket => {
    const hosts = parsedOptions.host.length > 0 ? parsedOptions.host : ["localhost"];
    const ports = parsedOptions.port.length > 0 ? parsedOptions.port : [5432];
    const index = hostIndex % hosts.length;
    hostIndex = (hostIndex + 1) % hosts.length;

    const host = hosts[index] ?? "localhost";
    const port = ports[index] ?? 5432;
    const keepAliveMs = typeof parsedOptions.keep_alive === "number" && parsedOptions.keep_alive > 0
      ? parsedOptions.keep_alive * 1_000
      : 0;

    const socket: SocketWithEndpoint = new net.Socket();
    socket.host = host;
    socket.port = port;

    let endDestroyTimer: ReturnType<typeof setTimeout> | null = null;
    const clearEndDestroyTimer = () => {
      if (endDestroyTimer !== null) {
        clearTimeout(endDestroyTimer);
        endDestroyTimer = null;
      }
    };

    const originalEnd = socket.end.bind(socket);
    socket.end = ((...args: Parameters<net.Socket["end"]>) => {
      if (endDestroyTimer === null && !socket.destroyed) {
        endDestroyTimer = setTimeout(() => {
          endDestroyTimer = null;
          if (!socket.destroyed) socket.destroy();
        }, closeGraceMs);
        endDestroyTimer.unref?.();
      }
      return originalEnd(...args);
    }) as net.Socket["end"];

    const originalDestroy = socket.destroy.bind(socket);
    socket.destroy = ((...args: Parameters<net.Socket["destroy"]>) => {
      clearEndDestroyTimer();
      return originalDestroy(...args);
    }) as net.Socket["destroy"];

    const originalEmit = socket.emit.bind(socket);
    socket.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (event === "close") {
        clearEndDestroyTimer();
      } else if (event === "connect" && keepAliveMs > 0) {
        socket.setKeepAlive(true, keepAliveMs);
      } else if (event === "timeout") {
        if (!socket.destroyed) socket.destroy();
        return true;
      }
      return originalEmit(event, ...args);
    }) as net.Socket["emit"];

    socket.setTimeout(socketTimeoutMs);
    if (typeof parsedOptions.path === "string" && parsedOptions.path.length > 0) {
      socket.connect(parsedOptions.path);
    } else {
      socket.connect(port, host);
    }
    return socket;
  };
}

/** Build shared self-recovering postgres.js options for edge functions. */
export function edgeDatabaseOptions(
  config: EdgeDatabaseConfig,
  encodedCa: string | undefined,
): EdgeDatabaseResolvedOptions {
  const base: EdgeDatabaseResolvedOptions = {
    max: config.max,
    prepare: false,
    idle_timeout: config.idle_timeout ?? EDGE_DATABASE_IDLE_TIMEOUT_SECONDS,
    connect_timeout: config.connect_timeout ?? EDGE_DATABASE_CONNECT_TIMEOUT_SECONDS,
    max_lifetime: config.max_lifetime ?? EDGE_DATABASE_MAX_LIFETIME_SECONDS,
    keep_alive: config.keep_alive ?? EDGE_DATABASE_KEEP_ALIVE_SECONDS,
    // postgres.js opens connections lazily per request; disable exponential backoff
    // (default up to 20s) so failed connects during a DB restart never poison the
    // first request after Postgres returns.
    backoff: () => 0,
    socket: createEdgeDatabaseSocketFactory({
      closeGraceMs: config.close_grace_ms,
      socketTimeoutMs: config.socket_timeout_ms,
    }),
  };
  return withDatabaseTls(base, encodedCa);
}

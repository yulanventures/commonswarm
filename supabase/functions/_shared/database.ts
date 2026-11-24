import postgres from "npm:postgres@3.4.9";
import { edgeDatabaseOptions, type EdgeDatabaseConfig } from "./database-options.ts";

export type { EdgeDatabaseConfig } from "./database-options.ts";

export const INVALID_DATABASE_CONFIGURATION_MESSAGE = "Edge database configuration is invalid";
export const EDGE_DATABASE_STALLED_CODE = "EDGE_DATABASE_STALLED";
export const EDGE_DATABASE_STALLED_MESSAGE = "Edge database connection stalled";

/** No-progress stall threshold (ms): above lock (5s) and statement (10s) bounds, below 30s client timeout. */
export const EDGE_DATABASE_STALL_TIMEOUT_MS = 15_000;
/**
 * Per-call ceiling (ms): releases a caller masked by a healthy sibling on multi-connection pools.
 * The caller is settled with EdgeDatabaseStalledError; work it already started outside the
 * database (such as an external HTTP fetch) may continue after settlement.
 */
export const EDGE_DATABASE_CALL_CEILING_MS = 25_000;
/** Minimum interval (ms) between pool replacements. */
export const EDGE_DATABASE_REPLACE_COOLDOWN_MS = 5_000;
/**
 * Maximum sockets the holder may reserve simultaneously across active and retired pools.
 * Expressed in sockets (not pools) so size-1, size-2, and size-4 pools share a hard allocation
 * bound even when half-closed sockets remain open on a vanished peer.
 */
export const EDGE_DATABASE_MAX_RETAINED_SOCKETS = 8;
/**
 * Conservative upper bound (ms) before a retired pool's unproven socket reservation expires.
 *
 * Justified from OS TCP teardown on Linux with keep_alive = 5 s (edgeDatabaseOptions):
 * - Idle / FIN_WAIT_2 keepalive teardown: TCP_KEEPIDLE (5 s) + tcp_keepcnt (9) * tcp_keepintvl (75 s) = 680 s.
 * - Active send / terminate('X' + FIN) to a vanished peer: tcp_retries2 (15) with 200 ms same-host RTO ≈ 925 s.
 * 960 s (16 min) exceeds both bounds; if keep_alive is configured higher, the holder scales up to
 * (keep_alive + 9 * 75) * 1000 ms.
 */
export const EDGE_DATABASE_RETIRED_SOCKET_TTL_MS = 960_000;

/** Fixed, secret-free, cause-free error returned when the holder retires or refuses a stalled pool. */
export class EdgeDatabaseStalledError extends Error {
  readonly code = EDGE_DATABASE_STALLED_CODE;

  constructor() {
    super(EDGE_DATABASE_STALLED_MESSAGE);
    this.name = "EdgeDatabaseStalledError";
  }
}

export interface EdgeDatabaseHolderConfig extends EdgeDatabaseConfig {
  /** No-progress stall threshold in ms (default 15,000). */
  stall_timeout_ms?: number;
  /** Per-call ceiling in ms (default 25,000); releases the caller while external work may continue. */
  call_ceiling_ms?: number;
  /** Minimum ms between pool replacements (default 5,000). */
  replace_cooldown_ms?: number;
  /** Maximum sockets reserved across active and retired pools before failing fast (default 8). */
  max_retained_sockets?: number;
  /** Upper bound in ms before a retired pool's unproven socket reservation expires (default >= 960,000). */
  retired_socket_ttl_ms?: number;
}

export interface EdgeDatabaseHolderSnapshot {
  generation: number;
  max: number;
  maxRetainedSockets: number;
  currentPoolSockets: number;
  retiredSockets: number;
  retainedSockets: number;
  retiredPoolCount: number;
}

const holderInspectors = new WeakMap<object, () => EdgeDatabaseHolderSnapshot>();

/** Read-only diagnostic snapshot of a holder's conservative socket reservations (for tests/monitoring). */
export function inspectEdgeDatabaseHolder(sql: unknown): EdgeDatabaseHolderSnapshot | null {
  if ((typeof sql !== "object" && typeof sql !== "function") || sql === null) return null;
  const inspector = holderInspectors.get(sql as object);
  return inspector ? inspector() : null;
}

interface PendingWaiter {
  id: number;
  startedAt: number;
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface PoolSlot {
  generation: number;
  sql: postgres.Sql;
  max: number;
  /** True once any operation has been dispatched on this pool (postgres.js connects lazily). */
  used: boolean;
  retired: boolean;
  retiredAt: number | null;
  /** True if more than `max` operations were pending at retirement (queries queue may hold waiters until end() destroys them). */
  hadQueuedAtRetire: boolean;
  /** True once slot.sql.end({ timeout: 0 }) has drained postgres.js's internal queries queue. */
  endCompleted: boolean;
  pending: Map<number, PendingWaiter>;
  lastSettlementAt: number;
  watchdogTimer: ReturnType<typeof setTimeout> | null;
  /** Distinct connection ids proven closed by postgres.js onclose after retirement. */
  retiredClosedIds: Set<number>;
}

const LINUX_DEFAULT_TCP_KEEPINTVL_SECONDS = 75;
const LINUX_DEFAULT_TCP_KEEPCNT = 9;

/**
 * Non-feature properties (Promise/thenable detection, serialization, runtime inspection) that
 * return undefined on the holder proxy so it is never treated as a thenable or broken under inspect.
 */
const HOLDER_INSPECTION_PROPERTIES = new Set<string>([
  "then",
  "catch",
  "finally",
  "toJSON",
  "inspect",
  "$$typeof",
  "asymmetricMatch",
  "nodeType",
  "__esModule",
  "default",
  "constructor",
  "valueOf",
  "toString",
  "name",
  "length",
  "prototype",
  "__proto__",
]);

function positiveBound(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

function clearWatchdog(slot: PoolSlot): void {
  if (slot.watchdogTimer !== null) {
    clearTimeout(slot.watchdogTimer);
    slot.watchdogTimer = null;
  }
}

/**
 * Open a bounded, pool-level self-recovering Postgres client for an edge worker isolate.
 *
 * TLS and socket lifecycle stay inside stock postgres.js (`withDatabaseTls` unchanged).
 * Recovery operates one level up by monitoring pool progress (15 s) and per-call ceilings (25 s,
 * which releases the waiting caller while any work it started outside the database may continue),
 * swapping in a fresh pool on stall, rejecting pending callers directly from the holder, and
 * conservatively accounting for retained sockets across active and retired pools.
 *
 * Because postgres.js 3.4.9 exposes only `onclose(connectionId)` and no connect/open lifecycle
 * callback, every pool reserves its full `max` socket count from the moment it dispatches any work
 * until closure of every connection id it could have opened is proven after retirement + `end()`
 * or the OS keepalive/retransmit teardown bound elapses.
 *
 * Forwarded client surface (exact set used by the eight edge pools and management bindings):
 * - tagged template / builder call (`apply`)
 * - `begin` (runs the entire transaction on the pool generation current at start; never replayed)
 * - `end`
 * Accessing any other client feature (e.g. `json`, `unsafe`, `array`, `listen`, `reserve`, `file`,
 * `types`) throws a clear error naming the unsupported property.
 */
export function createEdgeDatabase(
  databaseUrl: string,
  config: EdgeDatabaseHolderConfig,
  encodedCa: string | undefined = Deno.env.get("SWARM_DATABASE_TLS_CA_B64"),
): postgres.Sql {
  if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    throw new Error(INVALID_DATABASE_CONFIGURATION_MESSAGE);
  }

  const baseOptions = edgeDatabaseOptions(config, encodedCa);
  const stallTimeoutMs = positiveBound(config.stall_timeout_ms, EDGE_DATABASE_STALL_TIMEOUT_MS);
  const callCeilingMs = positiveBound(config.call_ceiling_ms, EDGE_DATABASE_CALL_CEILING_MS);
  const replaceCooldownMs = positiveBound(config.replace_cooldown_ms, EDGE_DATABASE_REPLACE_COOLDOWN_MS);
  const maxRetainedSockets = Math.max(
    baseOptions.max,
    Math.floor(positiveBound(config.max_retained_sockets, EDGE_DATABASE_MAX_RETAINED_SOCKETS)),
  );
  const keepAliveBoundMs =
    (baseOptions.keep_alive + LINUX_DEFAULT_TCP_KEEPCNT * LINUX_DEFAULT_TCP_KEEPINTVL_SECONDS) * 1_000;
  const defaultRetiredSocketTtlMs = Math.max(EDGE_DATABASE_RETIRED_SOCKET_TTL_MS, keepAliveBoundMs);
  const retiredSocketTtlMs = positiveBound(config.retired_socket_ttl_ms, defaultRetiredSocketTtlMs);

  let nextGeneration = 1;
  let nextWaiterId = 1;
  let holderClosed = false;
  let lastReplacedAt = Number.NEGATIVE_INFINITY;
  const retiredPools = new Set<PoolSlot>();

  function slotReservedSockets(slot: PoolSlot, now: number): number {
    if (!slot.used) return 0;
    if (!slot.retired) return slot.max;
    if (slot.retiredAt !== null && now - slot.retiredAt >= retiredSocketTtlMs) {
      retiredPools.delete(slot);
      return 0;
    }
    const remaining = Math.max(0, slot.max - slot.retiredClosedIds.size);
    if (remaining === 0) {
      retiredPools.delete(slot);
      return 0;
    }
    return remaining;
  }

  function countRetiredSockets(now: number): number {
    let total = 0;
    for (const retired of [...retiredPools]) {
      total += slotReservedSockets(retired, now);
    }
    return total;
  }

  function openPool(): PoolSlot {
    const generation = nextGeneration++;
    const slot: PoolSlot = {
      generation,
      sql: null as unknown as postgres.Sql,
      max: baseOptions.max,
      used: false,
      retired: false,
      retiredAt: null,
      hadQueuedAtRetire: false,
      endCompleted: false,
      pending: new Map(),
      lastSettlementAt: 0,
      watchdogTimer: null,
      retiredClosedIds: new Set(),
    };

    const onclose = (connectionId: number) => {
      // While live (or while queued waiters could still trigger a reconnect before end({ timeout: 0 })
      // drains postgres.js's queries queue), a close callback does not prove permanent release because
      // postgres.js may immediately reconnect that connection slot without an observable open hook.
      if (!slot.retired || (slot.hadQueuedAtRetire && !slot.endCompleted)) {
        return;
      }
      if (slot.retiredClosedIds.has(connectionId)) return;
      slot.retiredClosedIds.add(connectionId);
      if (slot.retiredClosedIds.size >= slot.max) {
        retiredPools.delete(slot);
      }
    };

    const poolOptions = {
      ...baseOptions,
      ...(baseOptions.ssl ? { ssl: { ...baseOptions.ssl } } : {}),
      onclose,
    };

    try {
      slot.sql = postgres(databaseUrl, poolOptions as postgres.Options<Record<string, never>>);
    } catch {
      // Discard parser/URL exceptions at the boundary so credential-bearing DSNs never
      // appear in thrown error messages, stacks, or causes.
      throw new Error(INVALID_DATABASE_CONFIGURATION_MESSAGE);
    }

    return slot;
  }

  // Construct the initial pool eagerly so malformed URLs/options fail immediately at creation.
  let currentPool: PoolSlot | null = openPool();

  function acquireSlot(): PoolSlot | null {
    if (holderClosed) return null;
    if (currentPool === null) {
      const now = Date.now();
      if (countRetiredSockets(now) + baseOptions.max > maxRetainedSockets) {
        return null;
      }
      currentPool = openPool();
    }
    return currentPool;
  }

  function rejectAllPending(slot: PoolSlot): void {
    const waiters = [...slot.pending.values()];
    slot.pending.clear();
    clearWatchdog(slot);
    for (const waiter of waiters) {
      if (waiter.settled) continue;
      waiter.settled = true;
      waiter.reject(new EdgeDatabaseStalledError());
    }
  }

  function handleStall(slot: PoolSlot, now: number): void {
    if (now - lastReplacedAt < replaceCooldownMs) {
      // Inside cooldown: reject pending waiters on the current pool, but reuse it.
      slot.lastSettlementAt = now;
      rejectAllPending(slot);
      return;
    }

    lastReplacedAt = now;
    slot.retired = true;
    slot.retiredAt = now;
    slot.hadQueuedAtRetire = slot.pending.size > slot.max;
    clearWatchdog(slot);
    if (slot.used) {
      retiredPools.add(slot);
    }

    // Swap in a fresh pool (or enter fail-fast cap state) BEFORE rejecting callers so
    // immediate caller retries observe the new generation or socket cap immediately.
    if (countRetiredSockets(now) + baseOptions.max <= maxRetainedSockets) {
      try {
        currentPool = openPool();
      } catch {
        currentPool = null;
      }
    } else {
      currentPool = null;
    }

    rejectAllPending(slot);

    try {
      Promise.resolve(slot.sql.end({ timeout: 0 }))
        .catch(() => {})
        .finally(() => {
          slot.endCompleted = true;
        });
    } catch {
      // Swallow synchronous close errors from a retired pool.
      slot.endCompleted = true;
    }
  }

  function scheduleWatchdog(slot: PoolSlot): void {
    clearWatchdog(slot);
    if (holderClosed || slot.retired || slot !== currentPool || slot.pending.size === 0) {
      return;
    }
    const oldest = slot.pending.values().next().value as PendingWaiter | undefined;
    if (!oldest) return;

    const noProgressAt = Math.max(slot.lastSettlementAt, oldest.startedAt) + stallTimeoutMs;
    const ceilingAt = oldest.startedAt + callCeilingMs;
    const deadline = Math.min(noProgressAt, ceilingAt);
    const delay = Math.max(0, deadline - Date.now());
    const generation = slot.generation;

    const timer = setTimeout(() => {
      // Generation fence: timers from a retired or superseded pool never affect the current pool.
      if (holderClosed || slot.retired || slot !== currentPool || slot.generation !== generation) {
        return;
      }
      slot.watchdogTimer = null;
      if (slot.pending.size === 0) return;

      const currentOldest = slot.pending.values().next().value as PendingWaiter | undefined;
      if (!currentOldest) return;

      const now = Date.now();
      const currentDeadline = Math.min(
        Math.max(slot.lastSettlementAt, currentOldest.startedAt) + stallTimeoutMs,
        currentOldest.startedAt + callCeilingMs,
      );
      if (now < currentDeadline) {
        scheduleWatchdog(slot);
        return;
      }
      handleStall(slot, now);
    }, delay);
    unrefTimer(timer);
    slot.watchdogTimer = timer;
  }

  function trackOperation<T>(dispatch: (sql: postgres.Sql) => PromiseLike<T>): Promise<T> {
    if (holderClosed) {
      return Promise.reject(
        Object.assign(new Error("Edge database connection ended"), { code: "CONNECTION_ENDED" }),
      );
    }
    const slot = acquireSlot();
    if (slot === null) {
      return Promise.reject(new EdgeDatabaseStalledError());
    }

    return new Promise<T>((resolve, reject) => {
      const waiter: PendingWaiter = {
        id: nextWaiterId++,
        startedAt: Date.now(),
        settled: false,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      const generation = slot.generation;
      slot.used = true;
      slot.pending.set(waiter.id, waiter);
      if (slot.pending.size === 1) {
        scheduleWatchdog(slot);
      }

      const settle = (ok: boolean, outcome: unknown) => {
        if (waiter.settled) {
          // Late result or error for a call the holder already rejected: discard.
          return;
        }
        waiter.settled = true;
        slot.pending.delete(waiter.id);
        // Generation fence: only the live current pool updates its progress clock and watchdog.
        if (!slot.retired && slot === currentPool && slot.generation === generation) {
          slot.lastSettlementAt = Date.now();
          scheduleWatchdog(slot);
        }
        if (ok) waiter.resolve(outcome);
        else waiter.reject(outcome);
      };

      let underlying: PromiseLike<T>;
      try {
        underlying = dispatch(slot.sql);
      } catch (syncError) {
        settle(false, syncError);
        return;
      }

      Promise.resolve(underlying).then(
        (value) => settle(true, value),
        (error) => settle(false, error),
      );
    });
  }

  function createLazyQuery(args: unknown[]): unknown {
    const first = args[0];
    const isTaggedTemplate = Boolean(
      first && typeof first === "object" && Array.isArray((first as { raw?: unknown }).raw),
    );
    if (!isTaggedTemplate) {
      const slot = acquireSlot();
      if (slot === null) {
        throw new EdgeDatabaseStalledError();
      }
      return Reflect.apply(slot.sql as unknown as (...callArgs: unknown[]) => unknown, undefined, args);
    }

    // Preserve postgres.js's lazy Query contract: do not execute or start the watchdog
    // until .then(), .catch(), .finally(), or .execute() is called.
    let started: Promise<unknown> | null = null;
    const start = (): Promise<unknown> => {
      if (started === null) {
        started = trackOperation((sql) =>
          Reflect.apply(sql as unknown as (...callArgs: unknown[]) => PromiseLike<unknown>, undefined, args)
        );
      }
      return started;
    };

    const lazy = {
      execute() {
        start();
        return lazy;
      },
      then(
        onFulfilled?: ((value: unknown) => unknown) | null,
        onRejected?: ((reason: unknown) => unknown) | null,
      ) {
        return start().then(onFulfilled, onRejected);
      },
      catch(onRejected?: ((reason: unknown) => unknown) | null) {
        return start().catch(onRejected);
      },
      finally(onFinally?: (() => void) | null) {
        return start().finally(onFinally);
      },
    };
    return lazy;
  }

  async function endHolder(options?: { timeout?: number }): Promise<void> {
    holderClosed = true;
    const active = currentPool;
    currentPool = null;
    const endings: Promise<unknown>[] = [];
    if (active !== null) {
      clearWatchdog(active);
      active.retired = true;
      active.retiredAt = Date.now();
      endings.push(
        Promise.resolve(active.sql.end(options))
          .catch(() => {})
          .finally(() => {
            active.endCompleted = true;
          }),
      );
    }
    for (const retired of [...retiredPools]) {
      clearWatchdog(retired);
      endings.push(
        Promise.resolve(retired.sql.end({ timeout: 0 }))
          .catch(() => {})
          .finally(() => {
            retired.endCompleted = true;
          }),
      );
    }
    retiredPools.clear();
    await Promise.all(endings);
  }

  const holder = new Proxy(function () {}, {
    apply(_target, _receiver, args) {
      return createLazyQuery(args);
    },
    get(_target, name) {
      if (name === "begin") {
        return (...args: unknown[]) =>
          trackOperation((sql) =>
            Reflect.apply(
              sql.begin as unknown as (...callArgs: unknown[]) => PromiseLike<unknown>,
              sql,
              args,
            )
          );
      }
      if (name === "end") {
        return (options?: { timeout?: number }) => endHolder(options);
      }
      if (typeof name === "symbol" || HOLDER_INSPECTION_PROPERTIES.has(name)) {
        return undefined;
      }
      throw new Error(`Edge database holder does not support postgres.js feature "${name}"`);
    },
  });

  holderInspectors.set(holder, () => {
    const now = Date.now();
    const retiredSockets = countRetiredSockets(now);
    const currentPoolSockets = currentPool && currentPool.used ? currentPool.max : 0;
    return {
      generation: currentPool ? currentPool.generation : nextGeneration - 1,
      max: baseOptions.max,
      maxRetainedSockets,
      currentPoolSockets,
      retiredSockets,
      retainedSockets: retiredSockets + currentPoolSockets,
      retiredPoolCount: retiredPools.size,
    };
  });

  return holder as unknown as postgres.Sql;
}

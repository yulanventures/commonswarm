import postgres from "npm:postgres@3.4.9";
import { edgeDatabaseOptions, type EdgeDatabaseConfig } from "./database-options.ts";

export type { EdgeDatabaseConfig } from "./database-options.ts";

export const INVALID_DATABASE_CONFIGURATION_MESSAGE = "Edge database configuration is invalid";
export const EDGE_DATABASE_STALLED_CODE = "EDGE_DATABASE_STALLED";
export const EDGE_DATABASE_STALLED_MESSAGE = "Edge database connection stalled";

/** No-progress stall threshold (ms): above lock (5s) and statement (10s) bounds, below 30s client timeout. */
export const EDGE_DATABASE_STALL_TIMEOUT_MS = 15_000;
/** Per-call ceiling (ms): bounds a silent call masked by a healthy sibling on size-2 pools. */
export const EDGE_DATABASE_CALL_CEILING_MS = 25_000;
/** Minimum interval (ms) between pool replacements. */
export const EDGE_DATABASE_REPLACE_COOLDOWN_MS = 5_000;
/** Maximum retired pools allowed to still hold unclosed sockets before failing fast. */
export const EDGE_DATABASE_MAX_RETIRED_POOLS = 4;

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
  /** Per-call ceiling in ms (default 25,000). */
  call_ceiling_ms?: number;
  /** Minimum ms between pool replacements (default 5,000). */
  replace_cooldown_ms?: number;
  /** Cap on retired pools still holding unclosed sockets (default 4). */
  max_retired_pools?: number;
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
  retired: boolean;
  pending: Map<number, PendingWaiter>;
  lastSettlementAt: number;
  watchdogTimer: ReturnType<typeof setTimeout> | null;
  /** Upper bound on currently open sockets in this pool, decremented by postgres.js onclose. */
  openSockets: number;
  /** Connection ids already observed closed after retirement. */
  retiredClosedIds: Set<number>;
}

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
 * Recovery operates one level up by monitoring pool progress and per-call ceilings, swapping
 * in a fresh pool on stall, rejecting pending callers directly from the holder, and bounding
 * retired pools whose half-open sockets have not yet closed.
 *
 * Forwarded client surface (exact set used by the eight edge pools and management bindings):
 * - tagged template / builder call (`apply`)
 * - `begin` (runs the entire transaction on the pool generation current at start; never replayed)
 * - `end`
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
  const maxRetiredPools = Math.max(1, Math.floor(positiveBound(config.max_retired_pools, EDGE_DATABASE_MAX_RETIRED_POOLS)));

  let nextGeneration = 1;
  let nextWaiterId = 1;
  let holderClosed = false;
  let lastReplacedAt = Number.NEGATIVE_INFINITY;
  const retiredPools = new Set<PoolSlot>();

  function openPool(): PoolSlot {
    const generation = nextGeneration++;
    const slot: PoolSlot = {
      generation,
      sql: null as unknown as postgres.Sql,
      max: baseOptions.max,
      retired: false,
      pending: new Map(),
      lastSettlementAt: 0,
      watchdogTimer: null,
      openSockets: 0,
      retiredClosedIds: new Set(),
    };

    const onclose = (connectionId: number) => {
      if (!slot.retired) {
        slot.openSockets = Math.max(0, slot.openSockets - 1);
        return;
      }
      if (slot.retiredClosedIds.has(connectionId)) return;
      slot.retiredClosedIds.add(connectionId);
      slot.openSockets = Math.max(0, slot.openSockets - 1);
      if (slot.openSockets === 0) {
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
      if (retiredPools.size >= maxRetiredPools) {
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
    clearWatchdog(slot);
    if (slot.openSockets > 0) {
      retiredPools.add(slot);
    }

    // Swap in a fresh pool (or enter fail-fast cap state) BEFORE rejecting callers so
    // immediate caller retries observe the new generation or cap immediately.
    if (retiredPools.size < maxRetiredPools) {
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
      Promise.resolve(slot.sql.end({ timeout: 0 })).catch(() => {});
    } catch {
      // Swallow synchronous close errors from a retired pool.
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
      slot.pending.set(waiter.id, waiter);
      slot.openSockets = Math.min(slot.max, Math.max(slot.openSockets, slot.pending.size));
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
      endings.push(Promise.resolve(active.sql.end(options)).catch(() => {}));
    }
    for (const retired of retiredPools) {
      clearWatchdog(retired);
      endings.push(Promise.resolve(retired.sql.end({ timeout: 0 })).catch(() => {}));
    }
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
      return undefined;
    },
  });

  return holder as unknown as postgres.Sql;
}

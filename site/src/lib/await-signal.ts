/**
 * Honest deadline-bounded signal waiting for observer tests.
 *
 * Avoids the `Promise.race([deferred.promise.then(() => true), Promise.resolve(false)])`
 * trap where an already-fulfilled `false` beats `.then(() => true)` even after the
 * underlying deferred has already resolved.
 */
export interface WaitableSignal {
  readonly promise: Promise<unknown>;
  readonly resolved: boolean;
}

export interface Signal<T = void> extends WaitableSignal {
  readonly promise: Promise<T>;
  readonly resolved: boolean;
  resolve: (value: T) => void;
}

export function createSignal<T = void>(): Signal<T> {
  let isResolved = false;
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolveFn = (value: T) => {
      isResolved = true;
      r(value);
    };
  });
  return {
    promise,
    get resolved() {
      return isResolved;
    },
    resolve: resolveFn,
  };
}

/**
 * Awaits a promise (or array of promises) until settled or `timeoutMs` elapses.
 * Returns `true` if all promises resolved before the deadline, or `false` on timeout.
 * Already-resolved promises return `true` even when `timeoutMs` is `0` because
 * microtasks settle before macrotask timers.
 */
export async function awaitSignal(
  signal: Promise<unknown> | readonly Promise<unknown>[],
  timeoutMs: number,
): Promise<boolean> {
  const target: Promise<unknown> = Array.isArray(signal)
    ? Promise.all(signal)
    : (signal as Promise<unknown>);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([
      target.then(() => true as const),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

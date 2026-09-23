import type { FunctionName } from "./router.ts";

export const EDGE_WORKER_EVENTS = {
  started: "edge_worker_started",
  ended: "edge_worker_ended",
} as const;

export const RUNTIME_METRICS_EVENT = "edge_runtime_metrics";

interface WorkerHandle {
  key: string;
  fetch(request: Request): Promise<Response>;
}

interface WorkerApi<Options> {
  create(options: Options): Promise<WorkerHandle>;
  memStats(): Promise<Map<string, unknown> | Record<string, unknown>>;
}

interface WorkerRecord {
  functionName: FunctionName;
  startedAt: number;
}

/** The pinned runtime returns the isolate UUID as worker.key, including on reuse. */
export function createWorkerObserver<Options>(
  workers: WorkerApi<Options>,
  log: (line: string) => void,
  now: () => number = Date.now,
) {
  const known = new Map<string, WorkerRecord>();

  return {
    async create(functionName: FunctionName, options: Options): Promise<WorkerHandle> {
      const worker = await workers.create(options);
      if (!known.has(worker.key)) {
        known.set(worker.key, { functionName, startedAt: now() });
        log(JSON.stringify({
          event: EDGE_WORKER_EVENTS.started,
          functionName,
          workerKey: worker.key,
          reason: null,
          ageMs: 0,
        }));
      }
      return worker;
    },

    async observeEnded(): Promise<void> {
      // Capture keys before the await so a concurrent create cannot look ended.
      const candidates = [...known.keys()];
      const present = await workers.memStats();
      for (const key of candidates) {
        if (present instanceof Map ? present.has(key) : Object.hasOwn(present, key)) {
          continue;
        }
        const record = known.get(key);
        if (!record) continue;
        known.delete(key);
        log(JSON.stringify({
          event: EDGE_WORKER_EVENTS.ended,
          functionName: record.functionName,
          workerKey: key,
          reason: null,
          ageMs: Math.max(0, now() - record.startedAt),
        }));
      }
    },
  };
}

export async function logRuntimeMetrics(
  getRuntimeMetrics: () => Promise<unknown>,
  log: (line: string) => void,
): Promise<void> {
  try {
    log(JSON.stringify({
      event: RUNTIME_METRICS_EVENT,
      metrics: await getRuntimeMetrics(),
    }));
  } catch {
    // A failed sample is not a reason to interrupt function traffic.
  }
}

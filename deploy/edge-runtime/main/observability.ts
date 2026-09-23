import type { FunctionName } from "./router.ts";

export const EDGE_WORKER_EVENTS = {
  started: "edge_worker_started",
  ended: "edge_worker_ended",
} as const;

export const RUNTIME_METRICS_PATH = "/_internal/metric";

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

export async function localMetricsResponse(
  request: Request,
  peerHostname: string,
  getRuntimeMetrics: () => Promise<unknown>,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== RUNTIME_METRICS_PATH) return null;
  if (peerHostname !== "127.0.0.1" && peerHostname !== "::1") {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(JSON.stringify(await getRuntimeMetrics()), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

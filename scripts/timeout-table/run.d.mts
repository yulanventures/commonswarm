import type { TimeoutInventoryRow } from "./enumerate.mjs";
export function argsOf(argv: string[]): {
  client: string | null; runs: number; pauseMs: number; ref: string | null;
  sourceTimeoutMs: number; mapping: string; output: string | null;
  acknowledgeNotMeasured: string[]; baseUrl?: string; profile?: string;
};
export function rowSummary(row: TimeoutInventoryRow, map: any, measured: any): {
  runs: number; p50: number | null; p95: number | null; max: number | null;
  headroom: number | null; gate: string;
};
export function assertNoOriginWrites(
  rows: Array<{ method?: string; path?: string; status?: string | number; duration_ms?: number }>,
  name: string,
): void;
export function runStatus(
  inventory: TimeoutInventoryRow[],
  mapping: any,
  measurements: Map<string, { durations: number[]; realTimeouts: number; realExitCodes?: Record<string, number> | null }>,
  acknowledged?: string[],
): { fails: string[]; notMeasured: string[]; missing: string[]; extra: string[] };
export function markdownReport(options: {
  baseUrl: string;
  inventory: TimeoutInventoryRow[];
  mapping: any;
  measurements: Map<string, { durations: number[]; realTimeouts: number; realExitCodes?: Record<string, number> | null }>;
  startup: { p50: number; p95: number; max: number } | null;
  ref?: string | null;
  client?: string | null;
}): string;
export function runTable(options: ReturnType<typeof argsOf> & { baseUrl: string; profile: string }): Promise<{
  report: string;
  inventory: TimeoutInventoryRow[];
  measurements: Map<string, unknown>;
  startup: { p50: number; p95: number; max: number } | null;
  status: { fails: string[]; notMeasured: string[]; missing: string[]; extra: string[] };
}>;
export interface TimeoutRunResources {
  repo: string;
  tempRoot: string | null;
  worktreePath: string | null;
}
export function cleanupRunResourcesSync(resources: TimeoutRunResources): void;
export function installRunResourceCleanup(resources: TimeoutRunResources): () => void;
export function sourceRootForRef(
  repo: string,
  ref: string | null,
  tempRoot: string,
  resources?: TimeoutRunResources,
): Promise<{ root: string }>;

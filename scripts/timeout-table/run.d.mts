import type { TimeoutInventoryRow } from "./enumerate.mjs";
export function markdownReport(options: {
  baseUrl: string;
  inventory: TimeoutInventoryRow[];
  mapping: any;
  measurements: Map<string, { durations: number[]; realTimeouts: number; realExitCodes?: Record<string, number> | null }>;
  startup: { p50: number; p95: number; max: number } | null;
}): string;
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

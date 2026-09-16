import type { TimeoutInventoryRow } from "./enumerate.mjs";
export function markdownReport(options: {
  baseUrl: string;
  inventory: TimeoutInventoryRow[];
  mapping: any;
  measurements: Map<string, { durations: number[]; realTimeouts: number; realExitCodes?: Record<string, number> | null }>;
  startup: { p50: number; p95: number; max: number } | null;
}): string;

export function percentile(values: number[], quantile: number): number | null;
export function summarize(values: number[], budgetMs: number, options?: {
  notNetwork?: boolean; notMeasured?: boolean; notRun?: boolean; realTimeouts?: number;
}): {
  runs: number; p50: number | null; p95: number | null; max: number | null;
  headroom: number | null; gate: "PASS" | "FAIL" | "NOT RUN" | "NOT NETWORK" | "NOT MEASURED";
};
export function makePrivateProfileCopy(profilePath: string, options?: { tempParent?: string }): Promise<{
  root: string; profilePath: string; profile: Record<string, any>; remove(): Promise<void>;
}>;
export function clientInvocation(client: string, args: string[]): { command: string; args: string[] };
export function withPrivateProfile<T>(profilePath: string, run: (copy: {
  root: string; profilePath: string; profile: Record<string, any>; remove(): Promise<void>;
}) => Promise<T>, options?: { tempParent?: string }): Promise<T>;
export function runChild(command: string, args: string[], options?: {
  cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean;
}): Promise<{ code: number; signal: NodeJS.Signals | null; durationMs: number; stdout: string; stderr: string }>;
export function readJsonLines(path: string): Promise<any[]>;

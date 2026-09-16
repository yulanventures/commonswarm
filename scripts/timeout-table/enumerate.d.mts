export interface TimeoutInventoryRow {
  id: string;
  value_ms: number;
  unit_note: string;
}
export function enumerateText(file: string, text: string): TimeoutInventoryRow[];
export function enumerateRepository(options: {
  repo: string;
  ref?: string | null;
  inputs?: string[];
}): TimeoutInventoryRow[];

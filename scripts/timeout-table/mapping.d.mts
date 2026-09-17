import type { TimeoutInventoryRow } from "./enumerate.mjs";
export const DEFAULT_MAPPING_REF: "HEAD";
export function knownMappingRefs(mapping: any): string[];
export function mappingForRef(mapping: any, ref?: string | null): { rows: Record<string, any> };
export function validateMapping(
  inventory: TimeoutInventoryRow[],
  mapping: any,
  ref?: string | null,
): true;

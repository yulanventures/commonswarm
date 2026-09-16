export function validateMapping(inventory, mapping) {
  if (!mapping || mapping.version !== 1 || !mapping.rows || typeof mapping.rows !== "object") {
    throw new Error("mapping must be version 1 with rows");
  }
  const enumerated = new Set(inventory.map(row => row.id));
  const mapped = new Set(Object.keys(mapping.rows));
  const missing = [...enumerated].filter(id => !mapped.has(id)).sort();
  const stale = [...mapped].filter(id => !enumerated.has(id)).sort();
  if (missing.length || stale.length) {
    throw new Error(`timeout mapping mismatch; missing=[${missing.join(", ")}]; stale=[${stale.join(", ")}]`);
  }
  for (const row of inventory) {
    const entry = mapping.rows[row.id];
    if (!new Set(["network-api", "local", "external"]).has(entry.class)) {
      throw new Error(`${row.id} has invalid class`);
    }
    if (!new Set(["per-request", "whole-operation"]).has(entry.scope)) {
      throw new Error(`${row.id} has invalid scope`);
    }
    if (!entry.citation || !entry.operation ||
        !new Set(["safe-read", "bounded-write", "not-run"]).has(entry.operation.class)) {
      throw new Error(`${row.id} has incomplete operation metadata`);
    }
  }
  return true;
}

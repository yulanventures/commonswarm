export const DEFAULT_MAPPING_REF = "HEAD";

export function knownMappingRefs(mapping) {
  const refs = mapping?.refs && typeof mapping.refs === "object" ? Object.keys(mapping.refs) : [];
  const aliases = mapping?.aliases && typeof mapping.aliases === "object" ? Object.keys(mapping.aliases) : [];
  return [...new Set([...refs, ...aliases])].sort();
}

export function mappingForRef(mapping, ref) {
  if (!mapping || mapping.version !== 2 || !mapping.refs || typeof mapping.refs !== "object") {
    throw new Error("mapping must be version 2 with a refs object");
  }
  const requested = ref == null ? DEFAULT_MAPPING_REF : ref;
  const aliases = mapping.aliases && typeof mapping.aliases === "object" ? mapping.aliases : {};
  const key = typeof aliases[requested] === "string" ? aliases[requested] : requested;
  const section = mapping.refs[key];
  if (!section || typeof section !== "object" || !section.rows || typeof section.rows !== "object") {
    throw new Error(
      `timeout mapping has no section for ref ${requested}; known=[${knownMappingRefs(mapping).join(", ")}]`,
    );
  }
  return section;
}

export function validateMapping(inventory, mapping, ref) {
  const section = mappingForRef(mapping, ref);
  const enumerated = new Set(inventory.map(row => row.id));
  const mapped = new Set(Object.keys(section.rows));
  const missing = [...enumerated].filter(id => !mapped.has(id)).sort();
  const stale = [...mapped].filter(id => !enumerated.has(id)).sort();
  if (missing.length || stale.length) {
    throw new Error(`timeout mapping mismatch; missing=[${missing.join(", ")}]; stale=[${stale.join(", ")}]`);
  }
  const scopesByOperation = new Map();
  for (const row of inventory) {
    const entry = section.rows[row.id];
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
    if (entry.operation.class === "safe-read") {
      const name = entry.operation.name;
      const previous = scopesByOperation.get(name);
      if (previous && previous !== entry.scope) {
        throw new Error(`operation ${name} has mixed scopes ${previous} and ${entry.scope}`);
      }
      scopesByOperation.set(name, entry.scope);
    }
  }
  return true;
}

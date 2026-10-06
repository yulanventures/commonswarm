/** Visible-label disambiguation for one context (UI-SPEC 2.3).
 *  A suffix appears only when two labels in this list would otherwise match.
 *  Callers split contexts first: alone labels across the workspace, nested
 *  labels within one owner group. Local type: home-types has no such row. */
import { foldIdentityName, IDENTITY_LABEL_SEPARATOR, IDENTITY_UUID_SUFFIX_MIN } from "./identity-label";

export interface VisibleName {
  id: string;
  label: string;
}

function suffixedVisibleLabel(shown: string, id: string, rows: readonly VisibleName[], taken: ReadonlySet<string>): string {
  const normalized = id.toLowerCase();
  const others = rows.map(row => row.id.toLowerCase()).filter(other => other !== normalized);
  for (let size = IDENTITY_UUID_SUFFIX_MIN; size <= normalized.length; size += 1) {
    const suffix = normalized.slice(0, size);
    if (others.some(other => other.slice(0, size) === suffix)) continue;
    const candidate = `${shown}${IDENTITY_LABEL_SEPARATOR}${suffix}`;
    if (taken.has(foldIdentityName(candidate))) continue;
    return candidate;
  }
  // Every id prefix, including the whole id, can already be a visible label.
  const full = `${shown}${IDENTITY_LABEL_SEPARATOR}${normalized}`;
  let candidate = full;
  let tail = 2;
  while (taken.has(foldIdentityName(candidate))) {
    candidate = `${full}${IDENTITY_LABEL_SEPARATOR}${tail}`;
    tail += 1;
  }
  return candidate;
}

/** Unique labels stay bare. Shared labels gain a short id prefix, grown until the result is unique. */
export function disambiguateVisibleLabels(rows: readonly VisibleName[]): Map<string, string> {
  const shown = rows.map(row => row.label.trim());
  const taken = new Set(shown.map(label => foldIdentityName(label)));
  const labels = new Map<string, string>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const label = shown[index]!;
    const folded = foldIdentityName(label);
    const shared = shown.some((item, itemIndex) => itemIndex !== index && foldIdentityName(item) === folded);
    if (!shared) {
      labels.set(row.id, label);
      continue;
    }
    const chosen = suffixedVisibleLabel(label, row.id, rows, taken);
    labels.set(row.id, chosen);
    taken.add(foldIdentityName(chosen));
  }
  return labels;
}

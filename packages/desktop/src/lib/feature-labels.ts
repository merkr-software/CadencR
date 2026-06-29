import type { Feature } from "@/api/generated";

/** Trim a label draft to a stored value, treating blank input as "no label". */
export function normalizeLabel(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Distinct, sorted set of existing feature labels (for label autocomplete). */
export function uniqueLabels(features: readonly Feature[]): string[] {
  const labels = new Set<string>();
  for (const feature of features) {
    const label = normalizeLabel(feature.label ?? "");
    if (label) labels.add(label);
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

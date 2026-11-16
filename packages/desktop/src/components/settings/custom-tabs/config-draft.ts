import type { TabConfigField } from "@/api/generated";

/**
 * The settings form's edit state, separate from what is stored.
 *
 * Secrets never come back from the service (a set one reads `{is_set: true}`),
 * so a secret's draft is an intent — keep, replace with a new value, clear —
 * never a value to show. Only fields the user changed go into the save
 * payload; an untouched secret is simply omitted, which the service reads as
 * "leave it alone".
 */
export type SecretDraft = { isSet: boolean; mode: "keep" | "replace" | "clear"; value: string };
export type DraftValue = string | boolean | SecretDraft;
export type Draft = Record<string, DraftValue>;

export function isSecretSet(stored: unknown): boolean {
  return (
    typeof stored === "object" && stored !== null && "is_set" in stored && stored.is_set === true
  );
}

function initialValue(field: TabConfigField, stored: unknown): DraftValue {
  const fallback: unknown = stored ?? field.default;
  switch (field.type) {
    case "boolean":
      return typeof fallback === "boolean" ? fallback : false;
    case "number":
      return typeof stored === "number" ? String(stored) : "";
    case "select":
      return typeof fallback === "string" ? fallback : "";
    case "secret": {
      const isSet = isSecretSet(stored);
      return { isSet, mode: isSet ? "keep" : "replace", value: "" };
    }
    default:
      return typeof stored === "string" ? stored : "";
  }
}

export function initialDraft(fields: TabConfigField[], stored: Record<string, unknown>): Draft {
  return Object.fromEntries(
    fields.map((field) => [field.key, initialValue(field, stored[field.key])]),
  );
}

/**
 * The draft for the fields declared now: an edit is kept while its field
 * still has the same kind of value; a field declared (or retyped) since the
 * draft started comes from `initial`.
 */
export function withDeclaredFields(draft: Draft, initial: Draft): Draft {
  return Object.fromEntries(
    Object.entries(initial).map(([key, value]) => {
      const edit = draft[key];
      return [key, edit !== undefined && typeof edit === typeof value ? edit : value];
    }),
  );
}

export interface DraftPayload {
  values: Record<string, unknown>;
  /** Field key → why its value can't be sent. */
  errors: Record<string, string>;
}

function secretChange(draft: SecretDraft): { changed: boolean; value: unknown } {
  if (draft.mode === "clear") return { changed: draft.isSet, value: null };
  if (draft.mode === "replace" && draft.value.length > 0)
    return { changed: true, value: draft.value };
  return { changed: false, value: undefined };
}

function fieldChange(
  field: TabConfigField,
  draft: DraftValue,
  initial: DraftValue,
): { changed: boolean; value: unknown; error?: string } {
  if (typeof draft === "object") return secretChange(draft);
  if (draft === initial) return { changed: false, value: undefined };
  if (typeof draft === "boolean") return { changed: true, value: draft };
  if (draft.trim() === "") return { changed: true, value: null };
  if (field.type !== "number") return { changed: true, value: draft };
  const number = Number(draft);
  return Number.isFinite(number)
    ? { changed: true, value: number }
    : { changed: true, value: undefined, error: "Enter a number." };
}

/** What a save would send: only the changed keys, `null` to remove a value. */
export function draftPayload(fields: TabConfigField[], draft: Draft, initial: Draft): DraftPayload {
  const payload: DraftPayload = { values: {}, errors: {} };
  for (const field of fields) {
    const current = draft[field.key];
    const before = initial[field.key];
    if (current === undefined || before === undefined) continue;
    const change = fieldChange(field, current, before);
    if (change.error) payload.errors[field.key] = change.error;
    else if (change.changed) payload.values[field.key] = change.value;
  }
  return payload;
}

export function defaultHint(field: TabConfigField): string | undefined {
  const value: unknown = field.default;
  if (typeof value === "string" || typeof value === "number") return `Default: ${value}`;
  return undefined;
}

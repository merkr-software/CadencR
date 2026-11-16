import { toast } from "sonner";
import type { z } from "zod";
import { parseJsonSetting } from "./json-setting";

/**
 * A value kept in localStorage as JSON, checked against `schema`. Unset reads
 * as null; an unreadable value is dropped with `resetNotice` so it can't fail
 * every later read.
 */
export function readLocalJson<T>(
  storageKey: string,
  schema: z.ZodType<T>,
  resetNotice: string,
): T | null {
  const { value, error } = parseJsonSetting(localStorage.getItem(storageKey), schema, "");
  if (error === null) return value;
  toast.error(resetNotice);
  localStorage.removeItem(storageKey);
  return null;
}

/** Store `value` as JSON (null removes it); a failure, e.g. a full quota, is toasted. */
export function writeLocalJson(storageKey: string, value: unknown, failure: string): void {
  try {
    if (value === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(value));
  } catch (error) {
    toast.error(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

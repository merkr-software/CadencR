import type { z } from "zod";

export type ParsedJsonSetting<T> = { value: T | null; error: string | null };

/**
 * A workspace setting stored as JSON, checked against `schema`. An unset
 * setting reads as null with no error; a malformed one says why, with
 * `expected` naming the shape when the JSON parses but doesn't fit.
 */
export function parseJsonSetting<T>(
  raw: string | null | undefined,
  schema: z.ZodType<T>,
  expected: string,
): ParsedJsonSetting<T> {
  if (!raw) return { value: null, error: null };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
  const result = schema.safeParse(json);
  return result.success ? { value: result.data, error: null } : { value: null, error: expected };
}

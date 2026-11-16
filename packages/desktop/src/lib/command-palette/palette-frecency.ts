/**
 * What the user picks from the palette, remembered per client: how often and
 * how recently. It lifts those entries in the ranking and orders the empty
 * state's Recent list, so the conversation or command used a minute ago is one
 * Enter away.
 */

import { z } from "zod";
import { parseJsonSetting } from "@/lib/json-setting";

const frecencyEntrySchema = z.object({
  /** Times picked. */
  count: z.number().int().nonnegative(),
  /** Last pick, ms since epoch. */
  at: z.number().nonnegative(),
});

const frecencyMapSchema = z.record(z.string(), frecencyEntrySchema);

export type FrecencyEntry = z.infer<typeof frecencyEntrySchema>;
export type FrecencyMap = z.infer<typeof frecencyMapSchema>;

const STORAGE_KEY = "cadencr.palette.frecency.v1";
const MAX_ENTRIES = 200;
const HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
/** The most a past pick adds to a match score. */
export const MAX_FRECENCY_BOOST = 0.3;

/**
 * The stored picks. A value that isn't valid JSON or doesn't match the schema
 * comes back as `error` with an empty map, for the caller to report and
 * overwrite on the next pick.
 */
export function readFrecency(storage: Pick<Storage, "getItem"> = localStorage): {
  map: FrecencyMap;
  error: string | null;
} {
  const { value, error } = parseJsonSetting(
    storage.getItem(STORAGE_KEY),
    frecencyMapSchema,
    "a map of picks with a count and a time",
  );
  return { map: value ?? {}, error };
}

/** Records a pick and keeps the newest {@link MAX_ENTRIES}. */
export function recordPick(map: FrecencyMap, key: string, now: number): FrecencyMap {
  const next: FrecencyMap = { ...map, [key]: { count: (map[key]?.count ?? 0) + 1, at: now } };
  const keys = Object.keys(next);
  if (keys.length <= MAX_ENTRIES) return next;
  const kept = keys.sort((a, b) => (next[b]?.at ?? 0) - (next[a]?.at ?? 0)).slice(0, MAX_ENTRIES);
  return Object.fromEntries(kept.map((kept) => [kept, next[kept] as FrecencyEntry]));
}

export function writeFrecency(
  map: FrecencyMap,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/** 0…1: more picks count, older picks fade with a three-day half-life. */
export function frecencyWeight(entry: FrecencyEntry | undefined, now: number): number {
  if (!entry) return 0;
  const decay = 0.5 ** (Math.max(0, now - entry.at) / HALF_LIFE_MS);
  return Math.min(1, (Math.log2(1 + entry.count) / 4) * decay + decay * 0.25);
}

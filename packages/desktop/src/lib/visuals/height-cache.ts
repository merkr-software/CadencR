import { LruCache } from "@/lib/lru-cache";

/**
 * Last rendered height per visual source. A virtualized transcript remounts a
 * visual every time it scrolls back into view; starting at the remembered
 * height keeps the list from jumping while the visual renders again.
 */
const heights = new LruCache<number>(200);

export function rememberedHeight(source: string): number | undefined {
  return heights.get(source);
}

export function rememberHeight(source: string, height: number): void {
  heights.set(source, height);
}

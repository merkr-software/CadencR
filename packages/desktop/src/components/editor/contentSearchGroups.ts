import type { ContentMatch } from "@/api/generated";

/** One file's matches, in the order the search returned them. */
export interface FileGroupData {
  path: string;
  matches: ContentMatch[];
}

export function groupByFile(matches: ContentMatch[]): FileGroupData[] {
  const map = new Map<string, ContentMatch[]>();
  for (const m of matches) {
    const existing = map.get(m.path);
    if (existing) {
      existing.push(m);
    } else {
      map.set(m.path, [m]);
    }
  }
  return Array.from(map.entries()).map(([path, ms]) => ({ path, matches: ms }));
}

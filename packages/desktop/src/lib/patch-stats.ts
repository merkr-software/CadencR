import { countHunkStats, parseUnifiedDiff } from "@/lib/parse-unified-diff";

export interface PatchStats {
  additions: number;
  deletions: number;
}

/**
 * Count additions/deletions across every hunk in a unified patch. Shared by
 * the inline diff renderer (which already builds the patch to feed
 * `PatchDiffView`) and the compact tool lines (which build it just to
 * summarise stats). Centralising avoids the two sites drifting on hunk
 * parsing.
 */
export function countPatchStats(patch: string): PatchStats {
  const [section] = parseUnifiedDiff(patch);
  return countHunkStats(section?.hunks ?? []);
}

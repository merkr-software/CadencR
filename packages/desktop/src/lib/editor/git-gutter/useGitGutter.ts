import { useMemo } from "react";
import type { Extension } from "@codemirror/state";
import { useGetFileContent } from "@/api/generated";
import { gitGutterExtension } from "./git-gutter-extension";

interface UseGitGutterArgs {
  projectId: number;
  featureId: number;
  filePath: string;
  /** Disable entirely in large-file mode — no markers, no diff work, no fetch. */
  enabled: boolean;
}

interface UseGitGutterResult {
  /** Mount once in the editor's extension array. Stable across renders. */
  extension: Extension;
  /**
   * The file's content at HEAD, or `null` when there is no baseline (untracked
   * / newly-added file, binary, or the fetch hasn't resolved). Feed this into
   * the editor via the `setGitGutterBaseline` effect. `undefined` for an empty
   * baseline is normalized to `null` so the consumer never has to special-case
   * the loading-vs-no-baseline distinction.
   */
  baseline: string | null;
}

// The gutter extension is static (no per-mount config), so build it once and
// share it — handing CodeMirror a fresh extension array would reset editor
// state on every render (see `.claude/rules/frontend-performance.md`).
const GIT_GUTTER_EXTENSION = gitGutterExtension();

/**
 * Supplies the editor's git change-marker gutter.
 *
 * Frontend-only: the HEAD baseline comes from the existing
 * `GET /api/git/file-content` endpoint (`mode: "uncommitted"` → `old_content`),
 * never a new route. The live buffer is diffed against that baseline inside the
 * editor extension, so markers update as the user types without any further
 * fetch. Untracked / new files have no `old_content`; the baseline is `null`
 * and the gutter simply renders nothing — graceful, no error.
 *
 * Deferred to a later wave (needs backend work owned by the LSP/service track):
 * inline-blame on the gutter and stage / revert-hunk actions.
 */
export function useGitGutter({
  projectId,
  featureId,
  filePath,
  enabled,
}: UseGitGutterArgs): UseGitGutterResult {
  const { data } = useGetFileContent(
    { feature_id: featureId, file_path: filePath, mode: "uncommitted" },
    {
      query: {
        enabled: enabled && Boolean(projectId && featureId && filePath),
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  );

  // Binary files have no meaningful text baseline to diff against.
  const baseline = useMemo<string | null>(() => {
    if (!enabled || !data || data.is_binary) return null;
    return data.old_content ?? null;
  }, [enabled, data]);

  return { extension: GIT_GUTTER_EXTENSION, baseline };
}

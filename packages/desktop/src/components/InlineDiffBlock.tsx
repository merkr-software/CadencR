import { useMemo } from "react";
import { PencilIcon, FilePlusIcon } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { toRelativePath } from "@/lib/utils";
import { NumStat } from "@/components/NumStat";
import { PatchDiffView } from "@/components/diff/PatchDiffView";
import { useOpenDiffInEditor } from "@/components/diff/OpenDiffInEditorContext";
import { createUnifiedPatch } from "@/lib/create-unified-patch";
import { firstChangedNewLine } from "@/lib/diff-line";
import { countHunkStats, parseUnifiedDiff } from "@/lib/parse-unified-diff";

interface InlineDiffBlockProps {
  filePath: string;
  oldContent: string;
  newContent: string;
  /** Base path to strip from filePath for display (e.g. project or worktree root) */
  basePath?: string;
  /** Tool name (Edit or Write) — shown as a label in the header */
  toolName?: string;
  onOpenFileInEditor?: (filePath: string, lineNumber?: number) => void;
}

/**
 * Compact inline diff block for displaying file changes during agent execution.
 * Uses the shared patch diff renderer with a synthesized unified patch.
 */
export function InlineDiffBlock({
  filePath,
  oldContent,
  newContent,
  basePath,
  toolName,
  onOpenFileInEditor,
}: InlineDiffBlockProps) {
  const ToolIcon = toolName === "Write" ? FilePlusIcon : PencilIcon;
  const { theme } = useTheme();
  const contextOpenFileInEditor = useOpenDiffInEditor();
  const openFileInEditor = onOpenFileInEditor ?? contextOpenFileInEditor;
  const displayPath = useMemo(() => toRelativePath(filePath, basePath), [filePath, basePath]);

  const patch = useMemo(
    () => createUnifiedPatch({ filePath: displayPath, oldContent, newContent }),
    [displayPath, oldContent, newContent],
  );
  const stats = useMemo(() => {
    const [section] = parseUnifiedDiff(patch);
    return countHunkStats(section?.hunks ?? []);
  }, [patch]);

  if (oldContent === newContent) {
    return (
      <div className="rounded-lg border border-[var(--editor-border)] bg-[var(--editor-bg)] px-3 py-2 text-xs text-[var(--editor-comment)]">
        No changes
      </div>
    );
  }

  const { additions, deletions } = stats;

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--editor-border)] bg-[var(--editor-bg)]">
      {/* Compact file header */}
      <div
        data-testid="inline-diff-header"
        className="flex items-center gap-2 border-b border-[var(--editor-border)] bg-[color-mix(in_srgb,var(--primary)_15%,var(--editor-bg))] px-3 py-1 text-xs"
      >
        {toolName && (
          <>
            <ToolIcon className="size-3 shrink-0 text-primary" />
            <span className="font-medium text-primary">{toolName}</span>
          </>
        )}
        <span className="flex-1 truncate font-mono text-[var(--editor-fg)]" title={filePath}>
          {displayPath}
        </span>
        <NumStat additions={additions} deletions={deletions} hideZero={false} />
        {openFileInEditor && (
          <button
            type="button"
            aria-label={`Edit ${displayPath} in editor`}
            title="Edit in editor"
            onClick={() => openFileInEditor(filePath, firstChangedNewLine(patch))}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-primary transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          >
            <PencilIcon className="size-3" />
            <span className="text-[11px] font-medium">Edit</span>
          </button>
        )}
      </div>

      {/* Diff content */}
      <PatchDiffView
        patch={patch}
        mode="unified"
        className="cadencr-patch-diff-inline max-h-[500px] overflow-auto"
        themeAppearance={theme.appearance}
        themeId={theme.id}
        disableFileHeader
        hunkSeparators="simple"
      />
    </div>
  );
}

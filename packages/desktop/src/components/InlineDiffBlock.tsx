import { useMemo } from "react";
import { ChevronRightIcon, PencilIcon, FilePlusIcon } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { useControllableBoolean } from "@/hooks/useControllableBoolean";
import { cn, toRelativePath } from "@/lib/utils";
import { NumStat } from "@/components/NumStat";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { PatchDiffView } from "@/components/diff/PatchDiffView";
import { useOpenDiffInEditor } from "@/components/diff/OpenDiffInEditorContext";
import { createUnifiedPatch } from "@/lib/create-unified-patch";
import { firstChangedNewLine } from "@/lib/diff-line";
import { countPatchStats } from "@/lib/patch-stats";

interface InlineDiffBlockProps {
  filePath: string;
  oldContent: string;
  newContent: string;
  /** Base path to strip from filePath for display (e.g. project or worktree root) */
  basePath?: string;
  /** Tool name (Edit or Write) — shown as a label in the header */
  toolName?: string;
  onOpenFileInEditor?: (filePath: string, lineNumber?: number) => void;
  /**
   * Controlled expand state. When provided, the diff body is hidden while
   * `expanded === false`; clicking the header toggles `onExpandedChange`. When
   * omitted, the diff stays fully expanded (legacy behavior).
   */
  expanded?: boolean;
  onExpandedChange?: (next: boolean) => void;
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
  expanded,
  onExpandedChange,
}: InlineDiffBlockProps) {
  const ToolIcon = toolName === "Write" ? FilePlusIcon : PencilIcon;
  const { theme } = useTheme();
  const contextOpenFileInEditor = useOpenDiffInEditor();
  const openFileInEditor = onOpenFileInEditor ?? contextOpenFileInEditor;
  const displayPath = useMemo(() => toRelativePath(filePath, basePath), [filePath, basePath]);
  // When controlled, the parent decides visibility. When uncontrolled (the
  // legacy callsite), the block stays expanded — matching pre-existing
  // behavior so non-verbosity callers don't suddenly hide their diffs.
  const { value: isExpanded, toggle: toggleExpanded } = useControllableBoolean({
    value: expanded,
    onChange: onExpandedChange,
    defaultValue: true,
  });

  const patch = useMemo(
    () => createUnifiedPatch({ filePath: displayPath, oldContent, newContent }),
    [displayPath, oldContent, newContent],
  );
  const stats = useMemo(() => countPatchStats(patch), [patch]);

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
      {/* Compact file header — clicking anywhere on the row toggles expand;
          nested buttons (Edit, chevron) stop propagation. */}
      <div
        data-testid="inline-diff-header"
        onClick={toggleExpanded}
        className="flex cursor-pointer items-center gap-2 border-b border-[var(--editor-border)] bg-[color-mix(in_srgb,var(--numstat-add-fg)_15%,var(--editor-bg))] px-3 py-1.5 text-xs"
      >
        {toolName && (
          <>
            {/* File-change tools keep the green "edit" identity (--numstat-add-fg)
                even once the diff renders, matching the pre-diff ToolCallBlock. */}
            <ToolIcon className="size-3 shrink-0 text-[var(--numstat-add-fg)]" />
            <span className="font-medium text-[var(--numstat-add-fg)]">{toolName}</span>
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
            onClick={(e) => {
              e.stopPropagation();
              openFileInEditor(filePath, firstChangedNewLine(patch));
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 leading-4 text-primary transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          >
            <PencilIcon className="size-3" />
            <span className="text-[11px] font-medium">Edit</span>
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded();
          }}
          className="shrink-0 text-primary/70 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? "Collapse diff" : "Expand diff"}
        >
          <ChevronRightIcon
            className={cn("size-3 transition-transform", isExpanded && "rotate-90")}
          />
        </button>
      </div>

      {/* Diff content */}
      <CollapsibleSection open={isExpanded}>
        <PatchDiffView
          patch={patch}
          mode="unified"
          className="cadencr-patch-diff-inline max-h-[500px] overflow-auto"
          themeAppearance={theme.appearance}
          themeId={theme.id}
          disableFileHeader
          hunkSeparators="simple"
        />
      </CollapsibleSection>
    </div>
  );
}

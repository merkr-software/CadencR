import { useCallback, useMemo, useState } from "react";
import { ChevronRightIcon, PencilIcon, FilePlusIcon } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { useControllableBoolean } from "@/hooks/useControllableBoolean";
import { cn, toRelativePath } from "@/lib/utils";
import { NumStat } from "@/components/NumStat";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { InlineDiffBody } from "@/components/InlineDiffBody";
import { useOpenDiffInEditor } from "@/components/diff/OpenDiffInEditorContext";
import { createUnifiedPatch } from "@/lib/create-unified-patch";
import { firstChangedNewLine } from "@/lib/diff-line";
import { countPatchStats } from "@/lib/patch-stats";
import { isLargeDiff, isLargeDiffByLines, utf8ByteLength } from "@/lib/diff-thresholds";

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
   * Expansion policy for ordinary diffs. Crash-risk large diffs always begin
   * locally collapsed and require an explicit click, regardless of this value.
   * When omitted, ordinary diffs stay fully expanded (legacy behavior).
   */
  expanded?: boolean;
  /** Reports ordinary diff policy changes; large-diff disclosure stays local. */
  onExpandedChange?: (next: boolean) => void;
}

interface InlineDiffHeaderProps {
  additions: number;
  deletions: number;
  displayPath: string;
  filePath: string;
  isExpanded: boolean;
  onOpenFileInEditor?: (filePath: string, lineNumber?: number) => void;
  patch: string;
  toggleExpanded: () => void;
  toolName?: string;
}

function InlineDiffHeader({
  additions,
  deletions,
  displayPath,
  filePath,
  isExpanded,
  onOpenFileInEditor,
  patch,
  toggleExpanded,
  toolName,
}: InlineDiffHeaderProps): React.ReactElement {
  const ToolIcon = toolName === "Write" ? FilePlusIcon : PencilIcon;
  return (
    <div
      data-testid="inline-diff-header"
      onClick={toggleExpanded}
      className="flex cursor-pointer items-center gap-2 border-b border-[var(--editor-border)] bg-[color-mix(in_srgb,var(--block-edit-accent,var(--numstat-add-fg))_15%,var(--editor-bg))] px-3 py-1.5 text-xs"
    >
      {toolName && (
        <>
          <ToolIcon className="size-3 shrink-0 text-[var(--block-edit-accent,var(--numstat-add-fg))]" />
          <span className="font-medium text-[var(--block-edit-accent,var(--numstat-add-fg))]">
            {toolName}
          </span>
        </>
      )}
      <span className="flex-1 truncate font-mono text-[var(--editor-fg)]">{displayPath}</span>
      <NumStat additions={additions} deletions={deletions} hideZero={false} />
      {onOpenFileInEditor && (
        <button
          data-inline-diff-edit-action
          type="button"
          aria-label={`Edit ${displayPath} in editor`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenFileInEditor(filePath, firstChangedNewLine(patch));
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 leading-4 text-primary transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        >
          <PencilIcon className="size-3" />
          <span className="text-[11px] font-medium">Edit</span>
        </button>
      )}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
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
  );
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
  const { theme } = useTheme();
  const contextOpenFileInEditor = useOpenDiffInEditor();
  const openFileInEditor = onOpenFileInEditor ?? contextOpenFileInEditor;
  const displayPath = useMemo(() => toRelativePath(filePath, basePath), [filePath, basePath]);
  const patch = useMemo(
    () => createUnifiedPatch({ filePath: displayPath, oldContent, newContent }),
    [displayPath, oldContent, newContent],
  );
  const stats = useMemo(() => countPatchStats(patch), [patch]);
  const [oldBytes, newBytes] = useMemo(
    () => [utf8ByteLength(oldContent), utf8ByteLength(newContent)],
    [oldContent, newContent],
  );
  const isLarge =
    isLargeDiff(oldBytes, newBytes) || isLargeDiffByLines(stats.additions, stats.deletions);
  // When controlled, the parent decides visibility. When uncontrolled (the
  // legacy callsite), the block stays expanded — matching pre-existing
  // behavior so non-verbosity callers don't suddenly hide their diffs.
  const { value: policyExpanded, toggle: togglePolicyExpanded } = useControllableBoolean({
    value: expanded,
    onChange: onExpandedChange,
    defaultValue: true,
  });
  const [largeExpanded, setLargeExpanded] = useState(false);
  const isExpanded = isLarge ? largeExpanded : policyExpanded;
  const toggleExpanded = useCallback((): void => {
    if (!isLarge) {
      togglePolicyExpanded();
      return;
    }
    setLargeExpanded((previous) => !previous);
  }, [isLarge, togglePolicyExpanded]);

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
      <InlineDiffHeader
        additions={additions}
        deletions={deletions}
        displayPath={displayPath}
        filePath={filePath}
        isExpanded={isExpanded}
        onOpenFileInEditor={openFileInEditor}
        patch={patch}
        toggleExpanded={toggleExpanded}
        toolName={toolName}
      />

      <CollapsibleSection open={isExpanded}>
        <InlineDiffBody
          isLarge={isLarge}
          patch={patch}
          patchLines={additions + deletions}
          themeId={theme.id}
          themeAppearance={theme.appearance}
        />
      </CollapsibleSection>
    </div>
  );
}

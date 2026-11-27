import { memo, useCallback, useState, type ReactElement } from "react";
import { InlineDiffBlock } from "@/components/InlineDiffBlock";
import {
  extractInlineDiffPreviews,
  normalizeToolName,
  type InlineDiffPreview,
} from "@/lib/tool-adapter";

/**
 * Renders the inline diff(s) produced by a file-change tool call (Edit,
 * Write, NotebookEdit, ApplyPatch). Extracted from `AgentBlock` to keep that
 * file under the 400-line budget. Single-diff tool calls use the parent
 * verbosity fold directly. Multi-diff tool calls treat that fold as a default
 * and keep per-diff user overrides, so expanding one file does not expand its
 * siblings.
 */
export function renderFileChangeBlocks(
  toolName: string | undefined,
  toolArgs: string | undefined,
  basePath: string | undefined,
  expanded: boolean | undefined,
  onExpandedChange: ((next: boolean) => void) | undefined,
): ReactElement | null {
  const normalizedToolName = normalizeToolName(toolName ?? "");
  const diffs = extractInlineDiffPreviews(toolName ?? "", toolArgs).filter(isVisibleInlineDiff);
  if (diffs.length === 0) return null;
  if (diffs.length === 1) {
    return renderInlineDiffBlock(
      diffs[0],
      basePath,
      normalizedToolName,
      undefined,
      expanded,
      onExpandedChange,
    );
  }
  return (
    <FileChangeBlockGroup
      diffs={diffs}
      basePath={basePath}
      toolName={normalizedToolName}
      policyExpanded={expanded}
      onPolicyExpandedChange={onExpandedChange}
    />
  );
}

function isVisibleInlineDiff(diff: { filePath: string }): boolean {
  return !diff.filePath.includes(".claude/plans/");
}

function renderInlineDiffBlock(
  diff: InlineDiffPreview,
  basePath: string | undefined,
  toolName: string,
  reactKey: string | undefined,
  expanded: boolean | undefined,
  onExpandedChange: ((next: boolean) => void) | undefined,
): ReactElement {
  return (
    <InlineDiffBlock
      key={reactKey}
      filePath={diff.filePath}
      oldContent={diff.oldContent}
      newContent={diff.newContent}
      emptyFileAction={diff.emptyFileAction}
      basePath={basePath}
      toolName={toolName}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    />
  );
}

interface FileChangeBlockGroupProps {
  diffs: InlineDiffPreview[];
  basePath: string | undefined;
  toolName: string;
  policyExpanded: boolean | undefined;
  onPolicyExpandedChange: ((next: boolean) => void) | undefined;
}

function FileChangeBlockGroup({
  diffs,
  basePath,
  toolName,
  policyExpanded,
  onPolicyExpandedChange,
}: FileChangeBlockGroupProps): ReactElement {
  return (
    <div className="space-y-2">
      {diffs.map((diff, index) => {
        const key = inlineDiffKey(diff, index);
        return (
          <InlineDiffGroupItem
            key={key}
            diff={diff}
            basePath={basePath}
            toolName={toolName}
            defaultExpanded={policyExpanded}
            onUncontrolledExpandedChange={onPolicyExpandedChange}
          />
        );
      })}
    </div>
  );
}

interface InlineDiffGroupItemProps {
  diff: InlineDiffPreview;
  basePath: string | undefined;
  toolName: string;
  defaultExpanded: boolean | undefined;
  onUncontrolledExpandedChange: ((next: boolean) => void) | undefined;
}

const InlineDiffGroupItem = memo(function InlineDiffGroupItem({
  diff,
  basePath,
  toolName,
  defaultExpanded,
  onUncontrolledExpandedChange,
}: InlineDiffGroupItemProps): ReactElement {
  const [expandedOverride, setExpandedOverride] = useState<boolean | undefined>();
  const handleControlledExpandedChange = useCallback((next: boolean): void => {
    setExpandedOverride(next);
  }, []);
  const expanded =
    defaultExpanded === undefined ? undefined : (expandedOverride ?? defaultExpanded);
  return renderInlineDiffBlock(
    diff,
    basePath,
    toolName,
    undefined,
    expanded,
    defaultExpanded === undefined ? onUncontrolledExpandedChange : handleControlledExpandedChange,
  );
});

function inlineDiffKey(diff: InlineDiffPreview, index: number): string {
  return `${index}:${diff.filePath}`;
}

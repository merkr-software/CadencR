import { useEffect, useId, useMemo, useRef } from "react";
import { FileWarningIcon } from "lucide-react";
import { PatchDiffView } from "@/components/diff/PatchDiffView";
import { useInViewport } from "@/hooks/useInViewport";
import {
  recordHeavyInlineMounted,
  recordHeavyInlineUnmounted,
  recordHeavyInlineUpdated,
  recordHeavyInlineVisible,
} from "@/lib/diff-render-diagnostics";
import { formatBytes, utf8ByteLength } from "@/lib/diff-thresholds";
import type { ThemeAppearance, ThemeId } from "@/lib/themes";

interface InlineDiffBodyProps {
  isLarge: boolean;
  patch: string;
  patchLines: number;
  themeAppearance: ThemeAppearance;
  themeId: ThemeId;
}

// Unlike the Git diff's opt-in progressive renderer, this path deliberately
// avoids mounting Pierre at all after the user expands a crash-risk inline diff.
function LargeInlineDiff({ patch, patchLines }: Pick<InlineDiffBodyProps, "patch" | "patchLines">) {
  const patchBytes = useMemo(() => utf8ByteLength(patch), [patch]);
  return (
    <div className="max-h-[500px] overflow-auto bg-[var(--editor-bg)]">
      <div className="sticky top-0 flex items-center gap-2 border-b border-[var(--editor-border)] bg-[var(--editor-bg)] px-3 py-2 text-xs text-[var(--editor-comment)]">
        <FileWarningIcon className="size-3.5 shrink-0" />
        <span>
          Large diff shown without syntax highlighting (about {formatBytes(patchBytes)},{" "}
          {patchLines.toLocaleString()} changed lines)
        </span>
      </div>
      <pre className="m-0 min-w-max p-3 font-mono text-xs leading-5 text-[var(--editor-fg)]">
        {patch}
      </pre>
    </div>
  );
}

export function InlineDiffBody({
  isLarge,
  patch,
  patchLines,
  themeAppearance,
  themeId,
}: InlineDiffBodyProps) {
  const blockId = useId();
  const viewportRootRef = useRef<HTMLElement | null>(null);
  const { setRef: viewportRef, inView: isNearViewport } = useInViewport(
    viewportRootRef,
    "600px 0px",
  );

  useEffect(() => {
    if (!isLarge) return;
    recordHeavyInlineMounted(blockId);
    return () => recordHeavyInlineUnmounted(blockId);
  }, [blockId, isLarge]);

  useEffect(() => {
    if (isLarge) recordHeavyInlineUpdated(blockId, patch.length, patchLines);
  }, [blockId, isLarge, patch.length, patchLines]);

  useEffect(() => {
    if (isLarge) recordHeavyInlineVisible(blockId, isNearViewport);
  }, [blockId, isLarge, isNearViewport]);

  return (
    <div ref={viewportRef} data-testid="inline-diff-body">
      {!isNearViewport ? (
        <div className="px-3 py-3 text-xs text-[var(--editor-comment)]">
          Diff renderer deferred until this change is near the viewport.
        </div>
      ) : isLarge ? (
        <LargeInlineDiff patch={patch} patchLines={patchLines} />
      ) : (
        <PatchDiffView
          patch={patch}
          mode="unified"
          className="cadencr-patch-diff-inline max-h-[500px] overflow-auto"
          themeAppearance={themeAppearance}
          themeId={themeId}
          disableFileHeader
          hunkSeparators="simple"
        />
      )}
    </div>
  );
}

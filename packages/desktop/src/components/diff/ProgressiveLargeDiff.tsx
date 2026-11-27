import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { splitFilePatch } from "@/lib/split-file-patch";
import { PatchDiffView, type PatchDiffViewProps } from "./PatchDiffView";

/**
 * Renders a large single-file patch without ever blocking the main thread:
 * the patch is split into bounded chunks (see `splitFilePatch`) and one chunk
 * is mounted per macrotask, yielding to input/paint between chunks. Each chunk
 * is a self-contained sub-patch with true line numbers, so comments and
 * navigation keep working.
 */
function ProgressiveLargeDiffImpl(props: PatchDiffViewProps) {
  const { t } = useUiTranslation();
  const { patch } = props;
  const chunks = useMemo(() => splitFilePatch(patch), [patch]);
  const [shownChunks, setShownChunks] = useState(chunks);
  const [visibleCount, setVisibleCount] = useState(1);

  // Reset to the first chunk DURING render (not in an effect) when the patch
  // changes. An effect would let one render commit `visibleCount` (possibly all
  // N) of the NEW chunks in a single frame before resetting — re-freezing on
  // the very patch change this component exists to smooth out. Setting state
  // here makes React discard this render and re-run with the reset values.
  if (shownChunks !== chunks) {
    setShownChunks(chunks);
    setVisibleCount(1);
  }

  useEffect(() => {
    if (visibleCount >= chunks.length) return;
    // setTimeout (not sync loop): the browser gets a chance to handle input
    // and paint between chunk mounts. Unmount cancels the remaining work.
    const timer = setTimeout(
      () => setVisibleCount((count) => Math.min(count + 1, chunks.length)),
      0,
    );
    return () => clearTimeout(timer);
  }, [visibleCount, chunks.length]);

  return (
    <>
      {chunks.slice(0, visibleCount).map((chunk, index) => (
        <PatchDiffView key={index} {...props} patch={chunk} />
      ))}
      {visibleCount < chunks.length && (
        <div
          className="text-muted-foreground flex items-center gap-2 border-t border-border bg-[var(--editor-bg)] px-4 py-3 font-mono text-xs"
          role="status"
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t(
            "workspace.git.progressiveLargeDiff.renderingDiffProgress",
            "Rendering diff… {{progress, number(style: percent)}}",
            { progress: visibleCount / chunks.length },
          )}
        </div>
      )}
    </>
  );
}

export const ProgressiveLargeDiff = memo(ProgressiveLargeDiffImpl);

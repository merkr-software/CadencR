import { useUiTranslation } from "@/lib/i18n/ui";
import { useEffect, useId, useMemo, type CSSProperties } from "react";
import { FileWarningIcon } from "lucide-react";
import { PatchDiffView } from "@/components/diff/PatchDiffView";
import {
  recordHeavyInlineMounted,
  recordHeavyInlineUnmounted,
  recordHeavyInlineUpdated,
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

/** Matches the `leading-5` rows Pierre and the plain-text fallback both render. */
const DIFF_LINE_HEIGHT_PX = 20;
/** Mirrors the `max-h-[500px]` both diff bodies scroll inside, below. */
const DIFF_MAX_HEIGHT_PX = 500;
/** Header/border of the scroll container, which the line count doesn't cover. */
const DIFF_CHROME_HEIGHT_PX = 24;

// Unlike the Git diff's opt-in progressive renderer, this path deliberately
// avoids mounting Pierre at all after the user expands a crash-risk inline diff.
function LargeInlineDiff({ patch, patchLines }: Pick<InlineDiffBodyProps, "patch" | "patchLines">) {
  const { t } = useUiTranslation();
  const patchBytes = useMemo(() => utf8ByteLength(patch), [patch]);
  return (
    <div className="max-h-[500px] overflow-auto bg-[var(--editor-bg)]">
      <div className="sticky top-0 flex items-center gap-2 border-b border-[var(--editor-border)] bg-[var(--editor-bg)] px-3 py-2 text-xs text-[var(--editor-comment)]">
        <FileWarningIcon className="size-3.5 shrink-0" />
        <span>
          {t(
            "conversation.stream.inlineDiffBody.largeDiff",
            "Large diff shown without syntax highlighting (about {{bytes}}, {{lines}} changed lines)",
            { bytes: formatBytes(patchBytes), lines: patchLines.toLocaleString() },
          )}
        </span>
      </div>
      <pre className="m-0 min-w-max p-3 font-mono text-xs leading-5 text-[var(--editor-fg)]">
        {patch}
      </pre>
    </div>
  );
}

/**
 * Renders an inline diff eagerly, letting the browser skip layout, style and
 * paint while it is off-screen (`deferred-paint`).
 *
 * This used to be gated behind an `IntersectionObserver` that decided whether to
 * *mount* the diff at all. That was a second virtualization layer stacked on the
 * stream's own, and the two disagreed: the observer measured against the browser
 * viewport while Virtuoso mounts rows well outside it, so a diff the user was
 * looking at could still be showing the "deferred" placeholder. Worse, resolving
 * a short placeholder into a 500px diff changed the row's height *after* it had
 * been measured — the conversation jumping while scrolling up.
 *
 * The trade is deliberate, not free: Pierre now instantiates for every expanded
 * diff in Virtuoso's mount window, which is wider than the old 600px observer
 * margin, and `content-visibility` skips rendering work but not React rendering
 * or patch parsing. What it buys is a height that no longer changes after
 * measurement, which is the actual bug.
 */
export function InlineDiffBody({
  isLarge,
  patch,
  patchLines,
  themeAppearance,
  themeId,
}: InlineDiffBodyProps) {
  const blockId = useId();

  useEffect(() => {
    if (!isLarge) return;
    recordHeavyInlineMounted(blockId);
    return () => recordHeavyInlineUnmounted(blockId);
  }, [blockId, isLarge]);

  useEffect(() => {
    if (isLarge) recordHeavyInlineUpdated(blockId, patch.length, patchLines);
  }, [blockId, isLarge, patch.length, patchLines]);

  // First-paint estimate only; `contain-intrinsic-size: auto` replaces it with
  // the real measured height as soon as the diff has rendered once.
  const style = useMemo(
    (): CSSProperties => ({
      ["--cadencr-intrinsic-height" as string]: `${Math.min(
        DIFF_MAX_HEIGHT_PX,
        patchLines * DIFF_LINE_HEIGHT_PX + DIFF_CHROME_HEIGHT_PX,
      )}px`,
    }),
    [patchLines],
  );

  return (
    <div className="deferred-paint" style={style} data-testid="inline-diff-body">
      {isLarge ? (
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

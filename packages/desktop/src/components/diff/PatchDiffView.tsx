import {
  createElement,
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import {
  DIFFS_TAG_NAME,
  FileDiff as PierreFileDiff,
  VirtualizedFileDiff as PierreVirtualizedFileDiff,
  areOptionsEqual,
  getSingularPatch,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type FileDiffOptions,
  type HunkSeparators,
  type SelectedLineRange,
  type VirtualFileMetrics,
} from "@pierre/diffs";
import { renderDiffChildren, templateRender, useVirtualizer } from "@pierre/diffs/react";
import { parseUnifiedDiff } from "@/lib/parse-unified-diff";
import type { PrThreadLine } from "@/lib/pr-review-threads";
import type { ThemeAppearance, ThemeId } from "@/lib/themes";
import { cn } from "@/lib/utils";
import {
  countTextLines,
  recordPierreCleaned,
  recordPierreCreated,
  recordPierreRenderCompleted,
  recordPierreRenderStarted,
} from "@/lib/diff-render-diagnostics";

import { DIFF_UNSAFE_CSS } from "./patch-diff-css";
import type { ActiveWidget, CommentCallbacks, CommentLineData } from "./diff-comment-decorations";
import {
  buildLineAnnotations,
  getCommentTarget,
  renderAnnotation,
  type CommentAnnotationMetadata,
  type CommentSide,
} from "./patch-diff-annotations";
import { ensurePierreThemesRegistered, getPierreThemeName } from "./pierre-theme";

export type PatchDiffMode = "unified" | "split";
export type PatchHunkSeparators = Exclude<HunkSeparators, "custom">;
export type { CommentSide };

export interface PatchDiffViewProps {
  patch: string;
  mode: PatchDiffMode;
  className?: string;
  commentLines?: CommentLineData[];
  /** Unresolved review threads the forge is hosting for this file. */
  remoteThreadLines?: PrThreadLine[];
  activeReviewThreadId?: string | null;
  selectedReviewThreadIds?: ReadonlySet<string>;
  onReviewThreadSelectedChange?: (threadId: string, selected: boolean) => void;
  activeWidget?: ActiveWidget | null;
  commentCallbacks?: CommentCallbacks;
  onAddComment?: (lineNumber: number, side: CommentSide) => void;
  themeAppearance: ThemeAppearance;
  themeId: ThemeId;
  collapsed?: boolean;
  focused?: boolean;
  disableFileHeader?: boolean;
  hunkSeparators?: PatchHunkSeparators;
  renderHeaderPrefix?: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderMetadata?: (fileDiff: FileDiffMetadata) => ReactNode;
}

interface SafePatchDiffProps<LAnnotation> {
  patch: string;
  options: FileDiffOptions<LAnnotation>;
  lineAnnotations?: DiffLineAnnotation<LAnnotation>[];
  renderAnnotation?: (annotation: DiffLineAnnotation<LAnnotation>) => ReactNode;
  renderHeaderPrefix?: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderMetadata?: (fileDiff: FileDiffMetadata) => ReactNode;
  className?: string;
}

interface RenderableFilePatch {
  stableKey: string;
  patch: string;
}

type PierreDiffInstance<LAnnotation> =
  | PierreFileDiff<LAnnotation>
  | PierreVirtualizedFileDiff<LAnnotation>;

function cleanUpManagedPierreHost<LAnnotation>(
  instance: PierreDiffInstance<LAnnotation> | null,
  container: HTMLElement | null,
): void {
  const cleanupStartedAt = performance.now();
  instance?.cleanUp();
  if (instance) recordPierreCleaned(instance.__id, performance.now() - cleanupStartedAt);
  // Clear managed shadow DOM so StrictMode cannot retain an orphaned virtualized placeholder.
  container?.shadowRoot?.replaceChildren();
}

// Pierre's "+" gutter affordance is hover-driven (it follows `pointermove` and
// is torn down on `pointerleave`), so on touch it only flickers in during a
// scroll and a tap can never reach it. Where the pointer can't hover, a tap on a
// line synthesizes the hover so the "+" appears on that line and stays (the user
// then taps it) — preserving the desktop two-step instead of jumping straight
// into the comment form.
const CAN_HOVER = typeof window === "undefined" || window.matchMedia("(hover: hover)").matches;

function revealGutterUtility(numberElement: HTMLElement): void {
  const rect = numberElement.getBoundingClientRect();
  numberElement.dispatchEvent(
    new PointerEvent("pointermove", {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
      composed: true,
      pointerType: "touch",
    }),
  );
}

const VIRTUAL_FILE_METRICS: Partial<VirtualFileMetrics> = {
  hunkLineCount: 80,
  lineHeight: 19,
  diffHeaderHeight: 38,
  hunkSeparatorHeight: 32,
};

function getRenderableFilePatches(patch: string): RenderableFilePatch[] {
  const sections = parseUnifiedDiff(patch);
  if (sections.length === 0) {
    return [{ stableKey: "single", patch }];
  }

  return sections.flatMap((section, sectionIndex) =>
    section.hunks.map((filePatch, hunkIndex) => {
      const fileKey = `${sectionIndex}:${section.oldFileName}->${section.newFileName}:${hunkIndex}`;
      return { stableKey: fileKey, patch: filePatch };
    }),
  );
}

function hashPatchKey(patch: string): string {
  let hash = 0;
  for (let i = 0; i < patch.length; i++) {
    hash = Math.imul(31, hash) + patch.charCodeAt(i);
  }
  return hash.toString(36);
}

function SafePatchDiff<LAnnotation>({
  patch,
  options,
  lineAnnotations,
  renderAnnotation,
  renderHeaderPrefix,
  renderHeaderMetadata,
  className,
}: SafePatchDiffProps<LAnnotation>) {
  const fileDiff = useMemo(() => getSingularPatch(patch), [patch]);
  const virtualizer = useVirtualizer();
  const instanceRef = useRef<PierreDiffInstance<LAnnotation> | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const fileDiffRef = useRef(fileDiff);
  const optionsRef = useRef(options);
  const lineAnnotationsRef = useRef(lineAnnotations);
  fileDiffRef.current = fileDiff;
  optionsRef.current = options;
  lineAnnotationsRef.current = lineAnnotations;

  const ref = useCallback(
    (node: HTMLElement | null): void => {
      if (!node) {
        cleanUpManagedPierreHost(instanceRef.current, containerRef.current);
        instanceRef.current = null;
        containerRef.current = null;
        return;
      }
      if (instanceRef.current) return;
      containerRef.current = node;
      const currentOptions = optionsRef.current;
      const instance = virtualizer
        ? new PierreVirtualizedFileDiff(
            currentOptions,
            virtualizer,
            VIRTUAL_FILE_METRICS,
            undefined,
            true,
          )
        : new PierreFileDiff(currentOptions, undefined, true);
      instanceRef.current = instance;
      recordPierreCreated(instance.__id, patch.length, countTextLines(patch));
      recordPierreRenderStarted(instance.__id);
      instance.hydrate({
        fileDiff: fileDiffRef.current,
        fileContainer: node,
        lineAnnotations: lineAnnotationsRef.current,
      });
    },
    [virtualizer],
  );

  useLayoutEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    const forceRender = !areOptionsEqual(instance.options, options);
    instance.setOptions(options);
    if (
      virtualizer &&
      instance instanceof PierreVirtualizedFileDiff &&
      instance.fileDiff !== fileDiff
    ) {
      const virtualizedInstance = instance as PierreVirtualizedFileDiff<LAnnotation>;
      // Keep the virtualized instance + host element alive across live patch
      // updates. Re-keying by patch content disconnects the old instance while
      // the scroll window still points into it; the replacement then combines
      // a stale `bufferBefore` with lines rendered from index 0, leaving a huge
      // empty band until the next user scroll.
      //
      // `prepareCodeViewItem` swaps the target and resets Pierre's layout cache
      // without touching the DOM. `rerender` then lets the outer Virtualizer
      // capture the OLD visible-line anchor before it renders the new target.
      virtualizedInstance.prepareCodeViewItem(fileDiff, virtualizedInstance.top ?? 0);
      virtualizedInstance.setLineAnnotations(lineAnnotations ?? []);
      recordPierreRenderStarted(instance.__id);
      virtualizedInstance.rerender();
      return;
    }
    recordPierreRenderStarted(instance.__id);
    instance.render({ forceRender, fileDiff, lineAnnotations });
  }, [fileDiff, lineAnnotations, options, virtualizer]);
  const getHoveredLine = useCallback(() => instanceRef.current?.getHoveredLine(), []);

  return createElement(
    DIFFS_TAG_NAME,
    { ref, className },
    templateRender(
      renderDiffChildren({
        fileDiff: fileDiff as FileDiffMetadata,
        renderCustomHeader: undefined,
        renderHeaderPrefix,
        renderHeaderMetadata,
        renderAnnotation,
        renderGutterUtility: undefined,
        lineAnnotations,
        getHoveredLine,
      }),
      undefined,
    ),
  );
}

function usePatchLineAnnotations({
  commentLines,
  remoteThreadLines,
  activeReviewThreadId,
  selectedReviewThreadIds,
  onReviewThreadSelectedChange,
  activeWidget,
  commentCallbacks,
}: Pick<
  PatchDiffViewProps,
  | "commentLines"
  | "remoteThreadLines"
  | "activeReviewThreadId"
  | "selectedReviewThreadIds"
  | "onReviewThreadSelectedChange"
  | "activeWidget"
  | "commentCallbacks"
>): DiffLineAnnotation<CommentAnnotationMetadata>[] | undefined {
  return useMemo(
    () =>
      buildLineAnnotations({
        commentLines,
        remoteThreadLines,
        activeWidget,
        callbacks: commentCallbacks,
        activeReviewThreadId,
        selectedReviewThreadIds,
        onReviewThreadSelectedChange,
      }),
    [
      activeReviewThreadId,
      activeWidget,
      commentCallbacks,
      commentLines,
      onReviewThreadSelectedChange,
      remoteThreadLines,
      selectedReviewThreadIds,
    ],
  );
}

function PatchDiffViewImpl({
  patch,
  mode,
  className,
  commentLines,
  remoteThreadLines,
  activeReviewThreadId,
  selectedReviewThreadIds,
  onReviewThreadSelectedChange,
  activeWidget,
  commentCallbacks,
  onAddComment,
  themeAppearance,
  themeId,
  collapsed = false,
  focused = false,
  disableFileHeader = false,
  hunkSeparators = "metadata",
  renderHeaderPrefix,
  renderHeaderMetadata,
}: PatchDiffViewProps) {
  ensurePierreThemesRegistered();
  const virtualizer = useVirtualizer();
  const filePatches = useMemo(() => getRenderableFilePatches(patch), [patch]);
  const lineAnnotations = usePatchLineAnnotations({
    commentLines,
    remoteThreadLines,
    activeReviewThreadId,
    selectedReviewThreadIds,
    onReviewThreadSelectedChange,
    activeWidget,
    commentCallbacks,
  });
  const handleAddComment = useCallback(
    (range: SelectedLineRange): void => {
      const target = getCommentTarget(range);
      onAddComment?.(target.lineNumber, target.side);
    },
    [onAddComment],
  );

  const options = useMemo<FileDiffOptions<CommentAnnotationMetadata>>(
    () => ({
      diffStyle: mode,
      hunkSeparators,
      diffIndicators: "classic",
      overflow: "scroll",
      theme: getPierreThemeName(themeId),
      themeType: themeAppearance,
      collapsed,
      disableFileHeader,
      lineDiffType: "word",
      maxLineDiffLength: 300,
      tokenizeMaxLineLength: 500,
      enableGutterUtility: Boolean(onAddComment),
      onGutterUtilityClick: onAddComment ? handleAddComment : undefined,
      onLineClick:
        !CAN_HOVER && onAddComment ? (line) => revealGutterUtility(line.numberElement) : undefined,
      onPostRender: (_node, instance, phase) => {
        if (phase !== "unmount") recordPierreRenderCompleted(instance.__id);
      },
      unsafeCSS: DIFF_UNSAFE_CSS,
    }),
    [
      mode,
      hunkSeparators,
      onAddComment,
      handleAddComment,
      themeAppearance,
      themeId,
      collapsed,
      disableFileHeader,
    ],
  );

  const diffClassName = cn(className, "group/patch-file", focused && "cadencr-patch-diff-focused");

  return (
    <>
      {filePatches.map((filePatch) => (
        <SafePatchDiff
          // Outside the Git virtualizer, remounting is still the safest way to
          // cancel Pierre's pending async highlight for an obsolete patch. In
          // the Git tab the stable instance is required for correct anchoring.
          key={
            virtualizer
              ? filePatch.stableKey
              : `${filePatch.stableKey}:${hashPatchKey(filePatch.patch)}`
          }
          patch={filePatch.patch}
          options={options}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          renderHeaderPrefix={renderHeaderPrefix}
          renderHeaderMetadata={renderHeaderMetadata}
          className={diffClassName}
        />
      ))}
    </>
  );
}

export const PatchDiffView = memo(PatchDiffViewImpl);

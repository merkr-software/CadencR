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
  type AnnotationSide,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type FileDiffOptions,
  type HunkSeparators,
  type SelectedLineRange,
  type VirtualFileMetrics,
} from "@pierre/diffs";
import { renderDiffChildren, templateRender, useVirtualizer } from "@pierre/diffs/react";
import { parseUnifiedDiff } from "@/lib/parse-unified-diff";
import type { ThemeAppearance, ThemeId } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { CommentExtendLine, CommentWidgetLine } from "./DiffCommentWidget";
import type { ActiveWidget, CommentCallbacks, CommentLineData } from "./diff-comment-decorations";
import { ensurePierreThemesRegistered, getPierreThemeName } from "./pierre-theme";

export type PatchDiffMode = "unified" | "split";
export type CommentSide = "old" | "new";
export type PatchHunkSeparators = Exclude<HunkSeparators, "custom">;

interface CommentAnnotationMetadata {
  comments: CommentLineData["comments"];
  isActive: boolean;
  callbacks: CommentCallbacks;
}

export interface PatchDiffViewProps {
  patch: string;
  mode: PatchDiffMode;
  className?: string;
  commentLines?: CommentLineData[];
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
  key: string;
  patch: string;
}

const VIRTUAL_FILE_METRICS: Partial<VirtualFileMetrics> = {
  hunkLineCount: 80,
  lineHeight: 19,
  diffHeaderHeight: 38,
  hunkSeparatorHeight: 32,
};

function getRenderableFilePatches(patch: string): RenderableFilePatch[] {
  const sections = parseUnifiedDiff(patch);
  if (sections.length === 0) return [{ key: `single:${hashPatchKey(patch)}`, patch }];

  return sections.flatMap((section, sectionIndex) =>
    section.hunks.map((filePatch, hunkIndex) => {
      const fileKey = `${sectionIndex}:${section.oldFileName}->${section.newFileName}:${hunkIndex}`;
      return { key: `${fileKey}:${hashPatchKey(filePatch)}`, patch: filePatch };
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
  const instanceRef = useRef<
    PierreFileDiff<LAnnotation> | PierreVirtualizedFileDiff<LAnnotation> | null
  >(null);
  const fileDiffRef = useRef(fileDiff);
  const optionsRef = useRef(options);
  const lineAnnotationsRef = useRef(lineAnnotations);
  fileDiffRef.current = fileDiff;
  optionsRef.current = options;
  lineAnnotationsRef.current = lineAnnotations;

  const ref = useCallback(
    (node: HTMLElement | null): void => {
      if (!node) {
        instanceRef.current?.cleanUp();
        instanceRef.current = null;
        return;
      }
      if (instanceRef.current) return;
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
    instance.render({ forceRender, fileDiff, lineAnnotations });
  }, [fileDiff, lineAnnotations, options]);
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
        renderHoverUtility: undefined,
        lineAnnotations,
        getHoveredLine,
      }),
      undefined,
    ),
  );
}

const DIFF_UNSAFE_CSS = `
  :host {
    display: block;
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
  }
  :host(.cadencr-patch-diff-focused) [data-diffs-header] {
    box-shadow: inset 0 0 0 1px var(--primary);
    background: var(--accent);
  }
  [data-diffs-header] {
    position: sticky;
    top: 0;
    z-index: 10;
    min-height: 38px;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar);
    color: var(--foreground);
  }
  [data-header-content] { min-width: 0; }
  [data-title], [data-prev-name] {
    min-width: 0;
    font-size: 12px;
  }
  [data-title] bdi, [data-prev-name] bdi {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-metadata] { font-size: 12px; }
  [data-metadata] {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  [data-metadata] slot[name="header-metadata"] {
    order: -1;
  }
  [data-utility-button] {
    background-color: var(--primary);
    color: var(--primary-foreground);
    fill: currentColor;
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--primary-foreground) 18%, transparent);
  }
  [data-utility-button]:hover,
  [data-utility-button]:focus-visible {
    background-color: color-mix(in oklab, var(--primary) 88%, var(--foreground));
    color: var(--primary-foreground);
  }
  :host(.cadencr-patch-diff-inline) [data-code] {
    padding-top: 0;
    padding-bottom: 0;
  }
  pre { font-size: 11.5px; line-height: 1.65; }
`;

function fromAnnotationSide(side: AnnotationSide | undefined): CommentSide {
  return side === "deletions" ? "old" : "new";
}

function getCommentTarget(range: SelectedLineRange): { lineNumber: number; side: CommentSide } {
  return {
    lineNumber: range.start,
    side: fromAnnotationSide(range.side ?? range.endSide),
  };
}

function toAnnotationSide(side: CommentSide | undefined): AnnotationSide {
  return side === "old" ? "deletions" : "additions";
}

function buildLineAnnotations(
  commentLines: CommentLineData[] | undefined,
  activeWidget: ActiveWidget | null | undefined,
  callbacks: CommentCallbacks | undefined,
): DiffLineAnnotation<CommentAnnotationMetadata>[] | undefined {
  if (!callbacks) return undefined;
  const annotations: DiffLineAnnotation<CommentAnnotationMetadata>[] = [];

  for (const line of commentLines ?? []) {
    if (line.comments.length === 0 || activeWidget?.lineNumber === line.lineNumber) continue;
    for (const side of ["new", "old"] as const) {
      const comments = line.comments.filter((comment) => comment.side === side);
      if (comments.length === 0) continue;
      annotations.push({
        side: toAnnotationSide(side),
        lineNumber: line.lineNumber,
        metadata: { comments, isActive: false, callbacks },
      });
    }
  }

  if (activeWidget) {
    const existing = commentLines
      ?.find((line) => line.lineNumber === activeWidget.lineNumber)
      ?.comments.filter((comment) => comment.side === (activeWidget.side ?? "new"));
    annotations.push({
      side: toAnnotationSide(activeWidget.side),
      lineNumber: activeWidget.lineNumber,
      metadata: { comments: existing ?? [], isActive: true, callbacks },
    });
  }

  return annotations.length > 0 ? annotations : undefined;
}

function renderAnnotation(annotation: DiffLineAnnotation<CommentAnnotationMetadata>): ReactNode {
  const { callbacks, comments, isActive } = annotation.metadata;
  if (isActive) {
    return (
      <CommentWidgetLine
        comments={comments}
        onSubmit={(content) => callbacks.onSubmit(annotation.lineNumber, content)}
        onClose={callbacks.onClose}
        onEdit={callbacks.onEdit}
        onDelete={callbacks.onDelete}
      />
    );
  }
  return (
    <CommentExtendLine
      comments={comments}
      onEdit={callbacks.onEdit}
      onDelete={callbacks.onDelete}
    />
  );
}

function PatchDiffViewImpl({
  patch,
  mode,
  className,
  commentLines,
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
  const filePatches = useMemo(() => getRenderableFilePatches(patch), [patch]);
  const lineAnnotations = useMemo(
    () => buildLineAnnotations(commentLines, activeWidget, commentCallbacks),
    [commentLines, activeWidget, commentCallbacks],
  );
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
          key={filePatch.key}
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

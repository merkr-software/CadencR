import type { FeatureNavigate } from "@/lib/feature-focus-handoff";
import {
  memo,
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { AllocatedPort, Feature, FeatureWorktreeInfo } from "@/api/generated";
import { ProjectFeatureContextMenu } from "@/components/ProjectFeatureContextMenu";
import { FeatureRowActions } from "@/components/ProjectFeatureRowParts";
import { FeatureHierarchyGutter } from "@/components/FeatureHierarchyGutter";
import { FeatureRowBody } from "@/components/FeatureRowBody";
import { useNavShortcutHint } from "@/hooks/useNavShortcutHints";
import {
  useProjectFeatureRowState,
  type ProjectFeatureRowState,
} from "@/hooks/useProjectFeatureRowState";
import { useOpenFeaturePort } from "@/hooks/useOpenFeaturePort";
import { useOpenFeaturePr } from "@/hooks/useOpenFeaturePr";
import { useSidebarRowActionListener } from "@/hooks/useSidebarRowActionListener";
import { useRowReorder } from "@/hooks/useRowReorder";

const ROW_KEYDOWN_IGNORED_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="combobox"]',
  "[data-ignore-feature-row-keydown]",
].join(", ");

interface ProjectFeatureRowProps {
  feature: Feature;
  projectId: number;
  activeFeatureId: number | null;
  liveTitle: string | undefined;
  isAutoNaming: boolean;
  /** True when the feature has a worktree recorded in feature settings (icon). */
  hasWorktree: boolean;
  /** True only when the worktree directory still exists on disk (stats query). */
  hasLiveWorktree: boolean;
  worktree: FeatureWorktreeInfo | undefined;
  shellCount: number;
  browserCount: number;
  downloadCount: number;
  /** Ports this conversation's own terminal/agent processes are listening on. */
  ports: readonly AllocatedPort[];
  isEditingLabel: boolean;
  labelDraft: string;
  labelSuggestions: readonly string[];
  isSavingLabel: boolean;
  onNavigate: FeatureNavigate;
  onStartLabelEdit: (feature: Feature) => void;
  onLabelDraftChange: (value: string) => void;
  onSaveLabel: (featureId: number, override?: string) => void;
  onCancelLabelEdit: () => void;
  onArchiveOrDelete: (featureId: number) => void;
  onUnarchive: (featureId: number) => void;
  onTogglePin: (featureId: number, pinned: boolean) => void;
  onCloseActivity: (
    featureId: number,
    shellCount: number,
    browserCount: number,
    downloadCount: number,
  ) => void;
  /** Expand/collapse twisty rendered by FeatureSubtree. */
  hierarchyControl?: ReactNode;
  /** Zero-based nesting depth; indentation stays inside the full-width row. */
  hierarchyDepth?: number;
  /** Children folded under this row (collapsed subtree); it signals their state. */
  hiddenDescendantIds?: readonly number[];
}

interface FeatureRowDetailsProps {
  props: ProjectFeatureRowProps;
  state: ProjectFeatureRowState;
  onOpenConversation: () => void;
  onOpenPort: (port: number) => void;
  onOpenPr: (prNumber: number | null) => void;
  badgeRef: RefObject<HTMLSpanElement | null>;
}

function FeatureRowDetails({
  props,
  state,
  onOpenConversation,
  onOpenPort,
  onOpenPr,
  badgeRef,
}: FeatureRowDetailsProps): ReactElement {
  const {
    feature,
    liveTitle,
    isAutoNaming,
    hasWorktree,
    worktree,
    shellCount,
    browserCount,
    downloadCount,
    ports,
    isEditingLabel,
    labelDraft,
    labelSuggestions,
    isSavingLabel,
    onLabelDraftChange,
    onSaveLabel,
    onCancelLabelEdit,
    onTogglePin,
    onArchiveOrDelete,
  } = props;
  return (
    <FeatureRowBody
      feature={feature}
      liveTitle={liveTitle}
      isAutoNaming={isAutoNaming}
      isArchived={state.isArchived}
      hasWorktree={hasWorktree}
      worktree={worktree}
      attention={state.attention}
      isActive={state.isActive}
      badgeRef={badgeRef}
      onOpenConversation={onOpenConversation}
      actions={
        <FeatureRowActions
          featureId={feature.id}
          isArchived={state.isArchived}
          isPinned={state.isPinned}
          onTogglePin={onTogglePin}
          onArchiveOrDelete={onArchiveOrDelete}
        />
      }
      prStatus={state.prStatus}
      gitStats={state.gitStats}
      shellCount={shellCount}
      browserCount={browserCount}
      downloadCount={downloadCount}
      ports={ports}
      labelEditor={
        isEditingLabel
          ? {
              draft: labelDraft,
              suggestions: labelSuggestions,
              isSaving: isSavingLabel,
              onDraftChange: onLabelDraftChange,
              onSave: (override) => onSaveLabel(feature.id, override),
              onCancel: onCancelLabelEdit,
            }
          : undefined
      }
      onOpenPort={onOpenPort}
      onOpenPr={onOpenPr}
    />
  );
}

interface FeatureRowMenuProps {
  props: ProjectFeatureRowProps;
  state: ProjectFeatureRowState;
  onStartLabelEditAfterMenuClose: () => void;
}

function FeatureRowMenu({
  props,
  state,
  onStartLabelEditAfterMenuClose,
}: FeatureRowMenuProps): ReactElement {
  const {
    feature,
    liveTitle,
    worktree,
    shellCount,
    browserCount,
    downloadCount,
    onNavigate,
    onTogglePin,
    onCloseActivity,
    onUnarchive,
    onArchiveOrDelete,
  } = props;
  return (
    <ProjectFeatureContextMenu
      feature={feature}
      liveTitle={liveTitle}
      worktree={worktree}
      pullRequest={state.prStatus?.pr}
      isArchived={state.isArchived}
      isPinned={state.isPinned}
      hasActivity={shellCount > 0 || browserCount > 0 || downloadCount > 0}
      shellCount={shellCount}
      browserCount={browserCount}
      downloadCount={downloadCount}
      onNavigate={onNavigate}
      onTogglePin={onTogglePin}
      onStartLabelEditAfterMenuClose={onStartLabelEditAfterMenuClose}
      onCloseActivity={onCloseActivity}
      onUnarchive={onUnarchive}
      onArchiveOrDelete={onArchiveOrDelete}
    />
  );
}

/**
 * Memoized: rendered N times per project in the sidebar. A parent update
 * (label edit, project rename) must not re-render every row. The parent
 * passes stable callback refs and a stable `labelSuggestions` reference, so
 * default shallow-prop comparison is sufficient.
 */
export const ProjectFeatureRow = memo(function ProjectFeatureRow(
  props: ProjectFeatureRowProps,
): ReactElement {
  const {
    feature,
    projectId,
    activeFeatureId,
    hasLiveWorktree,
    onNavigate,
    onStartLabelEdit,
    hierarchyControl,
    hierarchyDepth = 0,
    hiddenDescendantIds,
  } = props;
  const startLabelEditOnMenuCloseRef = useRef(false);
  const state = useProjectFeatureRowState(
    feature,
    projectId,
    activeFeatureId,
    hasLiveWorktree,
    hiddenDescendantIds,
  );
  const { navRef, badgeRef } = useNavShortcutHint<HTMLDivElement>();
  const markStartLabelEditAfterMenuClose = (): void => {
    startLabelEditOnMenuCloseRef.current = true;
  };

  const handleMenuCloseAutoFocus = (event: Event): void => {
    if (!startLabelEditOnMenuCloseRef.current) return;
    startLabelEditOnMenuCloseRef.current = false;
    event.preventDefault();
    onStartLabelEdit(feature);
  };

  const handleOpenConversation = useCallback((): void => {
    onNavigate(feature);
  }, [feature, onNavigate]);

  const handleOpenPort = useOpenFeaturePort(feature, onNavigate);
  const handleOpenPr = useOpenFeaturePr(feature, onNavigate);
  useSidebarRowActionListener(navRef, {
    label: () => onStartLabelEdit(feature),
    archive: () => props.onArchiveOrDelete(feature.id),
    pin: state.isArchived ? undefined : () => props.onTogglePin(feature.id, !state.isPinned),
  });
  const reorder = useRowReorder(navRef, feature.id, props.isEditingLabel);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={navRef}
          role="button"
          tabIndex={0}
          data-nav-item
          data-nav-type="feature"
          data-nav-id={String(feature.id)}
          data-nav-project-id={String(projectId)}
          data-feature-depth={hierarchyDepth}
          data-sidebar-pointed={state.isPointed || undefined}
          {...reorder}
          className={`sidebar-row group/feature relative flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 outline-none transition-colors hover:bg-sidebar-accent ${
            state.isActive ? "bg-sidebar-accent" : ""
          } ${state.isArchived ? "opacity-50" : ""}`}
          onClick={(e) => {
            if (state.isActive || e.detail > 1) return;
            onNavigate(feature);
          }}
          onMouseEnter={state.prefetchFeature}
          onFocus={state.prefetchFeature}
          onKeyDown={(e) => openFeatureRowOnKey(e, () => onNavigate(feature))}
        >
          <FeatureHierarchyGutter depth={hierarchyDepth}>{hierarchyControl}</FeatureHierarchyGutter>

          <FeatureRowDetails
            props={props}
            state={state}
            onOpenConversation={handleOpenConversation}
            onOpenPort={handleOpenPort}
            onOpenPr={handleOpenPr}
            badgeRef={badgeRef}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        // Open the label editor after the menu fully closes. Opening directly
        // from onSelect races with Radix's context-menu focus/pointer teardown.
        onCloseAutoFocus={handleMenuCloseAutoFocus}
      >
        <FeatureRowMenu
          props={props}
          state={state}
          onStartLabelEditAfterMenuClose={markStartLabelEditAfterMenuClose}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
});

export function shouldIgnoreFeatureRowKeyDown(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(ROW_KEYDOWN_IGNORED_SELECTOR) !== null;
}

/** Enter or Space on a conversation row (not on a control inside it) opens it. */
export function openFeatureRowOnKey(event: ReactKeyboardEvent, open: () => void): void {
  if (shouldIgnoreFeatureRowKeyDown(event.target)) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  open();
}

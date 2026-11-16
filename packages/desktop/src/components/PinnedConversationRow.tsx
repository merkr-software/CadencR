import type { FeatureNavigate } from "@/lib/feature-focus-handoff";
import {
  memo,
  useCallback,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { PinOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useNavShortcutHint } from "@/hooks/useNavShortcutHints";
import { ProjectBadge } from "@/components/ProjectBadge";
import { ProjectFeatureContextMenu } from "@/components/ProjectFeatureContextMenu";
import {
  useSidebarRowActions,
  type SidebarRowActions,
} from "@/components/SidebarRowActionsProvider";
import { useFeatureTitle } from "@/hooks/useFeatureTitle";
import { useOpenFeaturePort } from "@/hooks/useOpenFeaturePort";
import { useOpenFeaturePr } from "@/hooks/useOpenFeaturePr";
import { useRowLabelEditor } from "@/hooks/useRowLabelEditor";
import { useSidebarRowActionListener } from "@/hooks/useSidebarRowActionListener";
import { useRowReorder, type RowReorderProps } from "@/hooks/useRowReorder";
import {
  useProjectFeatureRowState,
  type ProjectFeatureRowState,
} from "@/hooks/useProjectFeatureRowState";
import { NO_PORTS } from "@/hooks/useFeaturePorts";
import { useBrowserStore } from "@/stores/browser-store";
import { openFeatureRowOnKey } from "@/components/ProjectFeatureRow";
import { FeatureRowBody } from "@/components/FeatureRowBody";
import { SidebarForMeDoneAction } from "@/components/SidebarForMeDoneAction";
import type { AllocatedPort, Feature, FeatureWorktreeInfo } from "@/api/generated";
import type { NextActionKind } from "@/lib/next-actions";

interface PinnedConversationRowProps {
  feature: Feature;
  activeFeatureId: number | null;
  /** Ports this conversation's own processes are listening on. */
  ports?: readonly AllocatedPort[];
  shellCount?: number;
  hasLiveWorktree?: boolean;
  worktree?: FeatureWorktreeInfo;
  onNavigate: FeatureNavigate;
  /** Pinned rows offer unpinning on hover; other cross-project rows (For me) don't. */
  showUnpin?: boolean;
  /** "For me" rows name what to do next under their title. */
  nextAction?: NextActionKind;
}

/**
 * A conversation row outside its project: Pinned, the blocks above the project
 * list (For me, In progress, Recent) and the cross-project lists (lenses,
 * views). It shows the same title and meta line as {@link ProjectFeatureRow}
 * (label, diff, PR, shells, ports) and offers the same context menu and row
 * shortcuts, so a conversation reads and acts the same wherever it appears.
 * The project color dot is the cross-project recognition cue (rows from
 * different projects sit together here). Memoized + self-subscribed to its own
 * live title/status via narrow per-feature selectors, so a WS push for one
 * conversation re-renders only that row, not the whole section. The parent
 * passes stable callbacks.
 */
export const PinnedConversationRow = memo(function PinnedConversationRow({
  feature,
  activeFeatureId,
  ports = NO_PORTS,
  shellCount = 0,
  hasLiveWorktree = false,
  worktree,
  onNavigate,
  showUnpin = false,
  nextAction,
}: PinnedConversationRowProps): ReactElement {
  const { navRef, badgeRef } = useNavShortcutHint<HTMLDivElement>();
  const { title: liveTitle, isAutoNaming } = useFeatureTitle(feature.id);
  const browserCount = useBrowserStore((store) => store.countsByScope[feature.id] ?? 0);
  const downloadCount = useBrowserStore(
    (store) => store.activeDownloadCountsByScope[feature.id] ?? 0,
  );
  const state = useProjectFeatureRowState(
    feature,
    feature.project_id,
    activeFeatureId,
    hasLiveWorktree,
  );
  const { isActive, prefetchFeature } = state;
  const handleOpenPort = useOpenFeaturePort(feature, onNavigate);
  const handleOpenPr = useOpenFeaturePr(feature, onNavigate);
  const actions = useSidebarRowActions();
  const label = useRowLabelEditor(feature);
  const reorder = useCrossProjectRowControls(navRef, actions, feature, state, label);
  const handleOpenConversation = useCallback(() => onNavigate(feature), [feature, onNavigate]);

  return (
    <CrossProjectRowMenu
      actions={actions}
      feature={feature}
      liveTitle={liveTitle ?? undefined}
      worktree={worktree}
      state={state}
      shellCount={shellCount}
      browserCount={browserCount}
      downloadCount={downloadCount}
      onNavigate={onNavigate}
      onStartLabelEdit={label.start}
    >
      <div
        ref={navRef}
        role="button"
        tabIndex={0}
        data-nav-item
        data-nav-type="feature"
        data-nav-id={String(feature.id)}
        data-nav-project-id={String(feature.project_id)}
        data-sidebar-pointed={state.isPointed || undefined}
        {...reorder}
        className={`sidebar-row group/pinned relative flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md pl-2 pr-1.5 outline-none transition-colors hover:bg-sidebar-accent ${
          isActive ? "bg-sidebar-accent" : ""
        }`}
        onClick={(e) => {
          if (isActive || e.detail > 1) return;
          onNavigate(feature);
        }}
        onMouseEnter={prefetchFeature}
        onFocus={prefetchFeature}
        onKeyDown={(e) => openFeatureRowOnKey(e, handleOpenConversation)}
      >
        {/* Pinned to the title line's height so it stays beside the title when the meta line shows. */}
        <span className="flex h-6 shrink-0 items-center self-start">
          <ProjectBadge projectId={feature.project_id} />
        </span>

        <FeatureRowBody
          feature={feature}
          liveTitle={liveTitle ?? undefined}
          isAutoNaming={isAutoNaming}
          isArchived={false}
          hasWorktree={hasLiveWorktree}
          worktree={worktree}
          attention={state.attention}
          isActive={isActive}
          badgeRef={badgeRef}
          onOpenConversation={handleOpenConversation}
          actions={rowHoverAction(feature.id, nextAction, showUnpin, actions)}
          nextAction={nextAction}
          prStatus={state.prStatus}
          gitStats={state.gitStats}
          shellCount={shellCount}
          browserCount={browserCount}
          downloadCount={downloadCount}
          ports={ports}
          labelEditor={label.editor}
          onOpenPort={handleOpenPort}
          onOpenPr={handleOpenPr}
        />
      </div>
    </CrossProjectRowMenu>
  );
});

/** The row's hover action: "done" for a For me entry, else unpin where offered. */
function rowHoverAction(
  featureId: number,
  nextAction: PinnedConversationRowProps["nextAction"],
  showUnpin: boolean,
  actions: ReturnType<typeof useSidebarRowActions>,
): ReactNode {
  if (nextAction) return <SidebarForMeDoneAction featureId={featureId} kind={nextAction} />;
  return (
    showUnpin && actions && <UnpinAction onUnpin={() => actions.togglePin(featureId, false)} />
  );
}

/**
 * The row shortcuts (pin, archive, label) through the sidebar's row actions,
 * plus the drag props that reorder the row inside its list (none while its
 * label editor is open).
 */
function useCrossProjectRowControls(
  rowRef: RefObject<HTMLDivElement | null>,
  actions: SidebarRowActions | null,
  feature: Feature,
  state: Pick<ProjectFeatureRowState, "isArchived" | "isPinned">,
  label: ReturnType<typeof useRowLabelEditor>,
): RowReorderProps {
  useSidebarRowActionListener(rowRef, {
    label: actions ? label.start : undefined,
    archive: actions ? () => actions.archiveOrDelete(feature) : undefined,
    pin:
      actions && !state.isArchived
        ? () => actions.togglePin(feature.id, !state.isPinned)
        : undefined,
  });
  return useRowReorder(rowRef, feature.id, label.editor !== undefined);
}

interface CrossProjectRowMenuProps {
  actions: SidebarRowActions | null;
  feature: Feature;
  liveTitle: string | undefined;
  worktree: FeatureWorktreeInfo | undefined;
  state: Pick<ProjectFeatureRowState, "prStatus" | "isArchived" | "isPinned">;
  shellCount: number;
  browserCount: number;
  downloadCount: number;
  onNavigate: FeatureNavigate;
  onStartLabelEdit: () => void;
  children: ReactElement;
}

/**
 * The project row's context menu on a row outside its project. Rows rendered
 * outside the sidebar (no actions to run) keep the plain row.
 */
function CrossProjectRowMenu({
  actions,
  feature,
  liveTitle,
  worktree,
  state,
  shellCount,
  browserCount,
  downloadCount,
  onNavigate,
  onStartLabelEdit,
  children,
}: CrossProjectRowMenuProps): ReactNode {
  const startLabelEditOnCloseRef = useRef(false);
  if (!actions) return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent
        // Open the label editor once the menu has closed: opening it from
        // onSelect races Radix's focus teardown (as on the project row).
        onCloseAutoFocus={(event) => {
          if (!startLabelEditOnCloseRef.current) return;
          startLabelEditOnCloseRef.current = false;
          event.preventDefault();
          onStartLabelEdit();
        }}
      >
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
          onTogglePin={actions.togglePin}
          onStartLabelEditAfterMenuClose={() => {
            startLabelEditOnCloseRef.current = true;
          }}
          onCloseActivity={(featureId, shells, browsers, downloads) =>
            actions.closeActivity({
              projectId: feature.project_id,
              featureId,
              shellCount: shells,
              browserCount: browsers,
              downloadCount: downloads,
            })
          }
          onUnarchive={actions.unarchive}
          onArchiveOrDelete={() => actions.archiveOrDelete(feature)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function UnpinAction({ onUnpin }: { onUnpin: () => void }): ReactElement {
  return (
    <span className="sidebar-row-actions">
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={true}
        className="size-6 shrink-0 p-0 text-foreground transition-none hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation();
          onUnpin();
        }}
      >
        <PinOffIcon className="size-3.5" />
        <span className="sr-only">Unpin</span>
      </Button>
    </span>
  );
}

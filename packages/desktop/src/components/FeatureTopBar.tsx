import { useRef, useState, type Dispatch, type ReactElement, type SetStateAction } from "react";
import { toast } from "sonner";
import { CopyIcon, PencilIcon, WandSparklesIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAutoNameFeature, useGetFeature } from "@/api/generated";
import { CustomActionsLauncher } from "./custom-actions/CustomActionsLauncher";
import { EmbeddedSessionHeader } from "./FeatureTopBarEmbedded";
import { GitActionButton } from "./git-actions/GitActionButton";
import { BranchChip } from "./branch-chip/BranchChip";
import { FeatureSettingsPopover } from "./FeatureSettingsPopover";
import { FeatureLabelChip } from "@/components/FeatureLabelChip";
import { Skeleton } from "@/components/ui/skeleton";
import { useFeatureTitle } from "@/hooks/useFeatureTitle";
import type { WorktreeStatus } from "@/types/workflow";
import { WorktreeSetupDetailsPanel } from "./WorktreeSetupSection";
import { useWorktreeSetup, type WorktreeSetupState } from "@/hooks/useWorktreeSetup";
import { WorktreeSetupHeader } from "./WorktreeSetupHeader";
import { ProjectBadge } from "@/components/ProjectBadge";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import { SidebarCollapsedChrome } from "@/components/SidebarCollapsedChrome";
import { useFeatureSettingsShortcuts } from "./useFeatureSettingsShortcuts";
import { HAS_MAC_WINDOW_CONTROLS } from "@/lib/mac-window-controls";
import { apiErrorMessage } from "@/lib/api-errors";
import { copyToClipboard } from "@/lib/clipboard";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ContextMenuActionItem } from "@/components/ContextMenuActionItem";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { FeatureRenameForm } from "./FeatureRenamePopover";

interface FeatureTopBarProps {
  featureId: number;
  projectId: number;
  mode?: "feature" | "session";
  className?: string;
  wsWorktreeStatus?: WorktreeStatus;
  wsWorktreeBranch?: string | null;
  wsWorktreeSetupOutput?: string[];
  wsWorktreeError?: string | null;
  onRetryWorktreeSetup?: () => void;
  showCustomActions?: boolean;
  showSidebarChrome?: boolean;
  draggable?: boolean;
  projectName?: string;
  titleOverride?: string;
  labelOverride?: string | null;
  lastActivityAt?: string | null;
  isPinned?: boolean;
  isPinPending?: boolean;
  onTogglePin?: () => void;
  onExclude?: () => void;
  hideEmbeddedWorktreeSetup?: boolean;
}

export function FeatureTopBar({
  showCustomActions = true,
  showSidebarChrome = true,
  ...props
}: FeatureTopBarProps): ReactElement | null {
  if (!showCustomActions && !showSidebarChrome && props.titleOverride) {
    return (
      <EmbeddedFeatureTopBar
        {...props}
        showCustomActions={showCustomActions}
        showSidebarChrome={showSidebarChrome}
      />
    );
  }
  return (
    <StandardFeatureTopBar
      {...props}
      showCustomActions={showCustomActions}
      showSidebarChrome={showSidebarChrome}
    />
  );
}

function EmbeddedFeatureTopBar({
  featureId,
  projectId,
  className,
  wsWorktreeStatus,
  wsWorktreeBranch,
  wsWorktreeSetupOutput,
  wsWorktreeError,
  onRetryWorktreeSetup,
  projectName,
  titleOverride,
  labelOverride,
  lastActivityAt,
  isPinned,
  isPinPending,
  onTogglePin,
  onExclude,
  hideEmbeddedWorktreeSetup,
}: FeatureTopBarProps): ReactElement {
  return (
    <EmbeddedSessionHeader
      featureId={featureId}
      projectId={projectId}
      projectName={projectName}
      title={titleOverride ?? ""}
      label={labelOverride}
      lastActivityAt={lastActivityAt}
      isPinned={isPinned}
      isPinPending={isPinPending}
      onTogglePin={onTogglePin}
      onExclude={onExclude}
      className={className}
      wsWorktreeStatus={wsWorktreeStatus}
      wsWorktreeBranch={wsWorktreeBranch}
      wsWorktreeSetupOutput={wsWorktreeSetupOutput}
      wsWorktreeError={wsWorktreeError}
      onRetryWorktreeSetup={onRetryWorktreeSetup}
      hideWorktreeSetup={hideEmbeddedWorktreeSetup}
    />
  );
}

function StandardFeatureTopBar({
  featureId,
  projectId,
  mode = "feature",
  className,
  wsWorktreeStatus,
  wsWorktreeBranch,
  wsWorktreeSetupOutput,
  wsWorktreeError,
  onRetryWorktreeSetup,
  showCustomActions = true,
  showSidebarChrome = true,
  draggable = true,
  titleOverride,
  labelOverride,
}: FeatureTopBarProps): ReactElement | null {
  const isSession = mode === "session";
  const { collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed } = useSidebarCollapsed();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { data: feature } = useGetFeature(featureId);
  // Live WS-pushed title from auto-naming (falls back to null).
  const { title: wsTitle, isAutoNaming } = useFeatureTitle(featureId);
  useFeatureSettingsShortcuts(isSession, setSettingsOpen);
  const worktreeSetup = useWorktreeSetup({
    featureId,
    projectId,
    wsWorktreeStatus,
    wsWorktreeBranch,
    wsWorktreeSetupOutput,
    wsWorktreeError,
    onRetrySetup: onRetryWorktreeSetup,
  });

  const title = wsTitle ?? feature?.title ?? titleOverride;
  const autoNameMutation = useAutoNameFeature({
    mutation: {
      onError: (error) => {
        toast.error(apiErrorMessage(error, "Auto-rename failed"));
      },
    },
  });

  if (!feature) return null;
  // Auto-rename is allowed even when the title is still default ("Session N",
  // "Untitled Feature") — that's exactly the case where the implicit naming
  // silently failed and the user wants to retry from the title context menu.
  const canAutoRename = title != null;
  const handleAutoRename = (): void => {
    if (autoNameMutation.isPending) return;
    autoNameMutation.mutate({ id: featureId });
  };

  return (
    <FeatureHeaderChrome
      featureId={featureId}
      projectId={projectId}
      className={className}
      featureTitle={title ?? feature.title}
      featureLabel={labelOverride !== undefined ? labelOverride : feature.label}
      isSession={isSession}
      isAutoNaming={isAutoNaming || autoNameMutation.isPending}
      canAutoRename={canAutoRename}
      isAutoRenamePending={autoNameMutation.isPending}
      onAutoRename={handleAutoRename}
      draggable={draggable}
      showCustomActions={showCustomActions}
      showSidebarChrome={showSidebarChrome}
      sidebarCollapsed={sidebarCollapsed}
      onExpandSidebar={() => setSidebarCollapsed(false)}
      settingsOpen={settingsOpen}
      onSettingsOpenChange={setSettingsOpen}
      worktreeSetup={worktreeSetup}
    />
  );
}

interface FeatureHeaderChromeProps {
  featureId: number;
  projectId: number;
  className?: string;
  featureTitle: string;
  featureLabel?: string | null;
  isSession: boolean;
  isAutoNaming: boolean;
  canAutoRename: boolean;
  isAutoRenamePending: boolean;
  onAutoRename: () => void;
  draggable: boolean;
  showCustomActions: boolean;
  showSidebarChrome: boolean;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  settingsOpen: boolean;
  onSettingsOpenChange: Dispatch<SetStateAction<boolean>>;
  worktreeSetup: WorktreeSetupState | null;
}

function FeatureHeaderChrome({
  featureId,
  projectId,
  className,
  featureTitle,
  featureLabel,
  isSession,
  isAutoNaming,
  canAutoRename,
  isAutoRenamePending,
  onAutoRename,
  draggable,
  showCustomActions,
  showSidebarChrome,
  sidebarCollapsed,
  onExpandSidebar,
  settingsOpen,
  onSettingsOpenChange,
  worktreeSetup,
}: FeatureHeaderChromeProps): ReactElement {
  const isMobile = useIsMobile();
  return (
    <>
      <div
        // Hooks for theme CSS (the CadencR chassis matches this header's
        // height to the sidebar header; `data-mac-controls` mirrors the same
        // platform constant `SidebarHeader` keys its height on).
        data-feature-header
        data-mac-controls={HAS_MAC_WINDOW_CONTROLS ? "true" : undefined}
        data-window-control-safe
        className={cn(
          draggable && "titlebar-drag",
          // Same height collapsed or not: the traffic lights move onto this
          // row (`SidebarCollapsedChrome`), the row never moves to them.
          "flex items-center gap-3 px-3 py-3 md:px-6",
          className,
        )}
      >
        {showSidebarChrome && (
          <SidebarCollapsedChrome visible={sidebarCollapsed} onExpand={onExpandSidebar} />
        )}
        {/* The worktree summary is a subtitle here, not a band below, so the
            header height doesn't change (see DESIGN.md "Worktree row"). */}
        <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3">
          <ProjectBadge projectId={projectId} size="md" className="justify-self-center" />
          <div className="flex min-w-0 items-center gap-3">
            {isAutoNaming ? (
              <Skeleton className="h-5 w-40" />
            ) : (
              <FeatureTitleMenu
                featureId={featureId}
                title={featureTitle}
                canAutoRename={canAutoRename}
                isAutoRenamePending={isAutoRenamePending}
                onAutoRename={onAutoRename}
              />
            )}
            <FeatureLabelChip label={featureLabel} />
          </div>
          {worktreeSetup && (
            <WorktreeSetupHeader
              {...worktreeSetup.header}
              className="col-span-2 grid-cols-subgrid gap-x-3"
            />
          )}
        </div>
        {showCustomActions && <CustomActionsLauncher featureId={featureId} projectId={projectId} />}

        {/*
         * Git header controls render in BOTH `feature` and `session` modes.
         * The session view drives the same `useGitStatusStore` (via
         * `useGitStatusSubscription` in `ws-session.$sessionId.tsx`), so the
         * commit / push / open-PR action and the current → target chip are
         * relevant there too.
         */}
        <GitActionButton featureId={featureId} projectId={projectId} />
        {/* On phones the branch chip lives inside the git popover (see
            `GitActionButton`) so the title isn't squeezed. */}
        {!isMobile && <BranchChip featureId={featureId} projectId={projectId} />}

        {!isSession && (
          <FeatureSettingsPopover
            featureId={featureId}
            open={settingsOpen}
            onOpenChange={onSettingsOpenChange}
          />
        )}
      </div>
      {worktreeSetup?.header.isOpen && <WorktreeSetupDetailsPanel {...worktreeSetup.details} />}
    </>
  );
}

interface FeatureTitleMenuProps {
  featureId: number;
  title: string;
  canAutoRename: boolean;
  isAutoRenamePending: boolean;
  onAutoRename: () => void;
}

function FeatureTitleMenu({
  featureId,
  title,
  canAutoRename,
  isAutoRenamePending,
  onAutoRename,
}: FeatureTitleMenuProps): ReactElement {
  const [renameOpen, setRenameOpen] = useState(false);
  // Opening the popover synchronously from `onSelect` races with the menu's
  // own dismissal (focus + pointer events dispatched during teardown dismiss
  // the freshly-mounted popover). Defer to `onCloseAutoFocus`, which fires
  // after the menu has fully unmounted.
  const openRenameOnMenuCloseRef = useRef(false);

  const handleCopy = (): void => {
    void copyToClipboard(title, "Copied feature name");
  };

  const handleMenuCloseAutoFocus = (event: Event): void => {
    if (!openRenameOnMenuCloseRef.current) return;
    openRenameOnMenuCloseRef.current = false;
    // Keep focus out of the h1 so the popover's FocusScope can claim the input.
    event.preventDefault();
    setRenameOpen(true);
  };

  return (
    <Popover open={renameOpen} onOpenChange={setRenameOpen}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <PopoverAnchor asChild>
            <h1
              className="min-w-0 cursor-default truncate text-lg font-semibold"
              onDoubleClick={() => setRenameOpen(true)}
            >
              {title}
            </h1>
          </PopoverAnchor>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={handleMenuCloseAutoFocus}>
          <ContextMenuActionItem icon={CopyIcon} onSelect={handleCopy}>
            Copy
          </ContextMenuActionItem>
          <ContextMenuActionItem
            icon={PencilIcon}
            onSelect={() => {
              openRenameOnMenuCloseRef.current = true;
            }}
          >
            Rename…
          </ContextMenuActionItem>
          {canAutoRename && (
            <ContextMenuActionItem
              icon={WandSparklesIcon}
              disabled={isAutoRenamePending}
              onSelect={onAutoRename}
            >
              Auto-rename
            </ContextMenuActionItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <PopoverContent align="start" className="w-80">
        <FeatureRenameForm
          featureId={featureId}
          currentTitle={title}
          open={renameOpen}
          onClose={() => setRenameOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

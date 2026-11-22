import { memo, type Dispatch, type ReactElement, type SetStateAction } from "react";
import { CommandPalette } from "@/components/CommandPalette";
import { ArchiveFeatureDialog } from "@/components/ArchiveFeatureDialog";
import { ArchiveCleanupDialog } from "@/components/ArchiveCleanupDialog";
import { ArchiveCleanupNotices } from "@/components/ArchiveCleanupNotices";
import { FeatureDeleteDialog } from "@/components/FeatureDeleteDialog";
import { AppCloseDialog } from "@/components/AppCloseDialog";
import { ServiceStatusNotifier } from "@/components/ServiceStatusNotifier";
import { ImageLightboxHost } from "@/components/ImageLightbox";
import { MermaidFullscreenHost } from "@/components/MermaidFullscreen";
import { KeyboardShortcutsModal } from "@/components/KeyboardShortcutsModal";
import { Toaster } from "@/components/ui/sonner";
import { SchedulesShortcut } from "@/components/SchedulesShortcut";
import { UnifiedAgentsShortcut } from "@/components/UnifiedAgentsShortcut";
import { PostUpdateChangelogDialog } from "@/components/PostUpdateChangelogDialog";
import { ThemeDrawer } from "@/components/theme/ThemeDrawer";
import { PluginTabPresenceKeeper } from "@/components/plugin-tabs/PluginTabPresenceKeeper";
import { PluginTabShortcutRelay } from "@/components/plugin-tabs/PluginTabShortcutRelay";
import { useRemoteUpdateCheck } from "@/hooks/useRemoteUpdateCheck";
import { useRouteFeatureIds, useRouteProjectId } from "@/hooks/useRouteFeatureIds";
import type { AppCloseState } from "@/hooks/useAppClose";
import { useShortcutsHelpStore } from "@/stores/shortcuts-help-store";
import { useListFeatureWorktrees, type Feature } from "@/api/generated";
import { getArchiveCleanupAvailability } from "@/components/archive-cleanup-availability";
import { type FeatureArchiveAction } from "@/lib/feature-archive-decision";
import { FEATURE_WORKTREES_STALE_MS } from "@/lib/sidebar-queries";
import type { ArchiveFeatureOptions } from "@/hooks/useArchiveFeatureAction";

export interface ConfirmFeatureAction {
  action: FeatureArchiveAction;
  feature: Feature;
}

interface RootOverlaysProps {
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: Dispatch<SetStateAction<boolean>>;
  confirmAction: ConfirmFeatureAction | null;
  setConfirmAction: Dispatch<SetStateAction<ConfirmFeatureAction | null>>;
  onArchiveFeature: (featureId: number, options: ArchiveFeatureOptions) => void;
  onDeleteFeature: (featureId: number) => void;
  appClose: AppCloseState;
}

/**
 * The app-wide dialogs, hosts and toaster. Memoized on stable props: the root
 * layout renders on every navigation, and none of this depends on the route
 * except the palette and the shortcuts help, which read it themselves.
 */
export const RootOverlays = memo(function RootOverlays({
  commandPaletteOpen,
  setCommandPaletteOpen,
  confirmAction,
  setConfirmAction,
  onArchiveFeature,
  onDeleteFeature,
  appClose,
}: RootOverlaysProps): ReactElement {
  // In a remote PWA, watch for newer host frontend code and offer a reload.
  useRemoteUpdateCheck();
  const archiveConfirmAction = confirmAction?.action === "archive" ? confirmAction : null;
  const deleteConfirmAction = confirmAction?.action === "delete" ? confirmAction : null;
  const archiveFeatureId = archiveConfirmAction?.feature.id ?? null;
  const archiveProjectId = archiveConfirmAction?.feature.project_id ?? null;
  const { data: featureWorktrees = [] } = useListFeatureWorktrees(
    { project_id: archiveProjectId ?? 0 },
    {
      query: {
        enabled: archiveProjectId != null && archiveFeatureId != null,
        staleTime: FEATURE_WORKTREES_STALE_MS,
      },
    },
  );
  const confirmFeatureWorktree =
    featureWorktrees.find((worktree) => worktree.feature_id === archiveFeatureId) ?? null;
  const cleanupAvailability = getArchiveCleanupAvailability(confirmFeatureWorktree);

  return (
    <>
      <RouteCommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      <UnifiedAgentsShortcut />
      <SchedulesShortcut />
      <PluginTabPresenceKeeper />
      <PluginTabShortcutRelay />
      <ShortcutsHelpHost />
      <Toaster />
      <ServiceStatusNotifier />
      <PostUpdateChangelogDialog />
      <ThemeDrawer />
      <ImageLightboxHost />
      <MermaidFullscreenHost />
      <ArchiveFeatureDialog
        open={archiveConfirmAction != null}
        feature={archiveConfirmAction?.feature}
        projectId={archiveProjectId ?? 0}
        hasLiveWorktree={cleanupAvailability.hasLiveWorktree}
        hasResidualWorktreeDirectory={cleanupAvailability.hasResidualWorktreeDirectory}
        showWorktreeRemoval={cleanupAvailability.showWorktreeRemoval}
        showBranchRemoval={cleanupAvailability.showBranchRemoval}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        onArchive={onArchiveFeature}
      />
      <FeatureDeleteDialog
        open={deleteConfirmAction != null}
        feature={deleteConfirmAction?.feature}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        onDelete={onDeleteFeature}
      />
      <ArchiveCleanupNotices />
      <ArchiveCleanupDialog />
      <AppCloseDialog state={appClose} />
    </>
  );
});

/** The palette with the open conversation, read here so a navigation re-renders only this. */
function RouteCommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: Dispatch<SetStateAction<boolean>>;
}): ReactElement {
  const { projectId, featureId } = useRouteFeatureIds();
  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      activeProjectId={projectId}
      activeFeatureId={featureId}
    />
  );
}

/**
 * The help modal's open state is owned by its store (driven by the global ⌘⇧?
 * shortcut and the Settings button), so it subscribes here rather than
 * re-rendering the overlays on every toggle; the project only changes it when
 * the user switches projects.
 */
function ShortcutsHelpHost(): ReactElement {
  const open = useShortcutsHelpStore((s) => s.open);
  const setOpen = useShortcutsHelpStore((s) => s.setOpen);
  const projectId = useRouteProjectId();
  return <KeyboardShortcutsModal open={open} onOpenChange={setOpen} projectId={projectId} />;
}

import type { Dispatch, ReactElement, SetStateAction } from "react";
import { CommandPalette } from "@/components/CommandPalette";
import { ArchiveFeatureDialog } from "@/components/ArchiveFeatureDialog";
import { FeatureDeleteDialog } from "@/components/FeatureDeleteDialog";
import { AppCloseDialog } from "@/components/AppCloseDialog";
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
import type { AppCloseState } from "@/hooks/useAppClose";
import { useShortcutsHelpStore } from "@/stores/shortcuts-help-store";
import { useListFeatureWorktrees, type Feature } from "@/api/generated";
import { getArchiveCleanupAvailability } from "@/components/archive-cleanup-availability";
import { type FeatureArchiveAction } from "@/lib/feature-archive-decision";
import type { ArchiveRelativeSelection } from "@/components/ArchiveRelativeOptions";

export interface ConfirmFeatureAction {
  action: FeatureArchiveAction;
  feature: Feature;
}

interface RootOverlaysProps {
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: Dispatch<SetStateAction<boolean>>;
  activeProjectId: number | null;
  activeFeatureId: number | null;
  confirmAction: ConfirmFeatureAction | null;
  setConfirmAction: Dispatch<SetStateAction<ConfirmFeatureAction | null>>;
  onArchiveFeature: (featureId: number, options: ArchiveRelativeSelection) => Promise<unknown>;
  onDeleteFeature: (featureId: number) => void;
  appClose: AppCloseState;
}

export function RootOverlays({
  commandPaletteOpen,
  setCommandPaletteOpen,
  activeProjectId,
  activeFeatureId,
  confirmAction,
  setConfirmAction,
  onArchiveFeature,
  onDeleteFeature,
  appClose,
}: RootOverlaysProps): ReactElement {
  // In a remote PWA, watch for newer host frontend code and offer a reload.
  useRemoteUpdateCheck();
  // The help modal's open state is owned by its store (driven by the global
  // ⌘⇧? shortcut and the Settings button), so it subscribes here rather than
  // re-rendering the root layout on every toggle.
  const shortcutsHelpOpen = useShortcutsHelpStore((s) => s.open);
  const setShortcutsHelpOpen = useShortcutsHelpStore((s) => s.setOpen);
  const archiveConfirmAction = confirmAction?.action === "archive" ? confirmAction : null;
  const deleteConfirmAction = confirmAction?.action === "delete" ? confirmAction : null;
  const archiveFeatureId = archiveConfirmAction?.feature.id ?? null;
  const archiveProjectId = archiveConfirmAction?.feature.project_id ?? null;
  const { data: featureWorktrees = [] } = useListFeatureWorktrees(
    { project_id: archiveProjectId ?? 0 },
    { query: { enabled: archiveProjectId != null && archiveFeatureId != null } },
  );
  const confirmFeatureWorktree =
    featureWorktrees.find((worktree) => worktree.feature_id === archiveFeatureId) ?? null;
  const cleanupAvailability = getArchiveCleanupAvailability(confirmFeatureWorktree);

  return (
    <>
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        activeProjectId={activeProjectId}
        activeFeatureId={activeFeatureId}
      />
      <UnifiedAgentsShortcut />
      <SchedulesShortcut />
      <PluginTabPresenceKeeper />
      <PluginTabShortcutRelay />
      <KeyboardShortcutsModal
        open={shortcutsHelpOpen}
        onOpenChange={setShortcutsHelpOpen}
        projectId={activeProjectId}
      />
      <Toaster />
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
      <AppCloseDialog state={appClose} />
    </>
  );
}

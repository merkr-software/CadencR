import type { Dispatch, ReactElement, SetStateAction } from "react";
import { CommandPalette } from "@/components/CommandPalette";
import { ArchiveFeatureDialog } from "@/components/ArchiveFeatureDialog";
import { FeatureDeleteDialog } from "@/components/FeatureDeleteDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { KeyboardShortcutsModal } from "@/components/KeyboardShortcutsModal";
import { Toaster } from "@/components/ui/sonner";
import { SchedulesShortcut } from "@/components/SchedulesShortcut";
import { UnifiedAgentsShortcut } from "@/components/UnifiedAgentsShortcut";
import { PostUpdateChangelogDialog } from "@/components/PostUpdateChangelogDialog";
import { ThemeDrawer } from "@/components/theme/ThemeDrawer";
import { useRemoteUpdateCheck } from "@/hooks/useRemoteUpdateCheck";
import { useShortcutsHelpStore } from "@/stores/shortcuts-help-store";
import { useListFeatureWorktrees, type Feature } from "@/api/generated";
import { getArchiveCleanupAvailability } from "@/components/archive-cleanup-availability";
import { type FeatureArchiveAction } from "@/lib/feature-archive-decision";

export interface ConfirmFeatureAction {
  action: FeatureArchiveAction;
  feature: Feature;
}

interface AppCloseOverlayState {
  showConfirm: boolean;
  setShowConfirm: Dispatch<SetStateAction<boolean>>;
  confirmAndClose: () => void;
  runningAgents: Array<{ sessionId: string; label: string }>;
}

interface RootOverlaysProps {
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: Dispatch<SetStateAction<boolean>>;
  activeProjectId: number | null;
  activeFeatureId: number | null;
  confirmAction: ConfirmFeatureAction | null;
  setConfirmAction: Dispatch<SetStateAction<ConfirmFeatureAction | null>>;
  onArchiveFeature: (featureId: number) => void;
  onDeleteFeature: (featureId: number) => void;
  appClose: AppCloseOverlayState;
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
  const { data: featureWorktrees = [] } = useListFeatureWorktrees(
    { project_id: activeProjectId ?? 0 },
    { query: { enabled: activeProjectId != null && archiveFeatureId != null } },
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
      <KeyboardShortcutsModal open={shortcutsHelpOpen} onOpenChange={setShortcutsHelpOpen} />
      <Toaster position="top-center" />
      <PostUpdateChangelogDialog />
      <ThemeDrawer />
      <ArchiveFeatureDialog
        open={archiveConfirmAction != null}
        feature={archiveConfirmAction?.feature}
        projectId={activeProjectId ?? 0}
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
      <ConfirmDialog
        open={appClose.showConfirm}
        onOpenChange={appClose.setShowConfirm}
        title="Quit Cadencr?"
        description="The following agents are still running. They will be stopped and can be resumed next time you open the app."
        confirmText="Quit"
        variant="destructive"
        onConfirm={appClose.confirmAndClose}
      >
        <ul className="text-sm text-muted-foreground space-y-1 py-2">
          {appClose.runningAgents.map((agent) => (
            <li key={agent.sessionId}>{agent.label}</li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  );
}

import { useUiTranslation } from "@/lib/i18n/ui";
import { memo } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { ImportConversationsDialog } from "./import/ImportConversationsDialog";
import { NewProjectOnboardingDialog } from "./NewProjectOnboardingDialog";
import { ProjectLocationDialog } from "./ProjectLocationDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import type { ProjectTreeController } from "./ProjectTree";

/** Memoized on the tree's controller, which keeps its identity across conversation switches. */
export const ProjectTreeDialogs = memo(function ProjectTreeDialogs({
  controller,
}: {
  controller: ProjectTreeController;
}) {
  const { t } = useUiTranslation();
  return (
    <>
      {controller.settingsProject && (
        <ProjectSettingsDialog
          projectId={controller.settingsProject.id}
          projectName={controller.settingsProject.name}
          authoringTarget={controller.settingsProject.authoringTarget}
          open
          onOpenChange={(open) => {
            if (!open) controller.setSettingsProject(null);
          }}
        />
      )}
      {controller.locationTarget && (
        <ProjectLocationDialog
          key={`${controller.locationTarget.id}-${controller.locationTarget.mode}`}
          target={controller.locationTarget}
          onClose={() => controller.setLocationTarget(null)}
        />
      )}
      {controller.onboarding.onboardingProject && (
        <NewProjectOnboardingDialog
          projectId={controller.onboarding.onboardingProject.id}
          projectName={controller.onboarding.onboardingProject.name}
          open
          onOpenChange={(open) => {
            if (!open) controller.onboarding.close();
          }}
        />
      )}
      {controller.importProject && (
        <ImportConversationsDialog
          projectId={controller.importProject.id}
          projectName={controller.importProject.name}
          open
          onOpenChange={(open) => {
            if (!open) controller.setImportProject(null);
          }}
        />
      )}
      <ConfirmDialog
        open={controller.archiveSessionsProject !== null}
        onOpenChange={(open) => {
          if (!open) controller.setArchiveSessionsProject(null);
        }}
        title={t("project.treeDialogs.archiveTitle", 'Archive all sessions in "{{name}}"?', {
          name: controller.archiveSessionsProject?.name ?? "",
        })}
        description={t(
          "project.treeDialogs.archiveDescription",
          "This will archive every session in this project that is not pinned and not currently running. Archived sessions are hidden from the sidebar and this cannot be undone.",
        )}
        confirmText={t("common.archive", "Archive")}
        variant="destructive"
        busy={controller.mutations.archiveProjectSessions.isPending}
        onConfirm={async () => {
          const target = controller.archiveSessionsProject;
          if (!target) return;
          try {
            await controller.mutations.archiveProjectSessions.mutateAsync({ id: target.id });
          } catch {
            // Keep the dialog open so the user can retry; the mutation's
            // onError already surfaced the failure as a toast.
            return false;
          }
        }}
      />
      <ConfirmDialog
        open={controller.deleteProject !== null}
        onOpenChange={(open) => {
          if (!open) controller.setDeleteProject(null);
        }}
        title={t("project.treeDialogs.deleteTitle", 'Delete "{{name}}"?', {
          name: controller.deleteProject?.name ?? "",
        })}
        description={t(
          "project.treeDialogs.deleteDescription",
          "This will permanently delete the project and all its features, plans, sessions, and settings. This action cannot be undone.",
        )}
        confirmText={t("common.delete", "Delete")}
        variant="destructive"
        onConfirm={() => {
          if (controller.deleteProject)
            controller.mutations.deleteProject.mutate({ id: controller.deleteProject.id });
        }}
      />
    </>
  );
});

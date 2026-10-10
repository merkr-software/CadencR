import { ConfirmDialog } from "./ConfirmDialog";
import { ImportConversationsDialog } from "./import/ImportConversationsDialog";
import { NewProjectOnboardingDialog } from "./NewProjectOnboardingDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import type { ProjectTreeController } from "./ProjectTree";

export function ProjectTreeDialogs({ controller }: { controller: ProjectTreeController }) {
  return (
    <>
      {controller.settingsProject && (
        <ProjectSettingsDialog
          projectId={controller.settingsProject.id}
          projectName={controller.settingsProject.name}
          open
          onOpenChange={(open) => {
            if (!open) controller.setSettingsProject(null);
          }}
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
        title={`Archive all sessions in "${controller.archiveSessionsProject?.name}"?`}
        description="This will archive every session in this project that is not pinned and not currently running. Archived sessions are hidden from the sidebar and this cannot be undone."
        confirmText="Archive"
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
        title={`Delete "${controller.deleteProject?.name}"?`}
        description="This will permanently delete the project and all its features, plans, sessions, and settings. This action cannot be undone."
        confirmText="Delete"
        variant="destructive"
        onConfirm={() => {
          if (controller.deleteProject)
            controller.mutations.deleteProject.mutate({ id: controller.deleteProject.id });
        }}
      />
    </>
  );
}

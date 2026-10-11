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
          authoringTarget={controller.settingsProject.authoringTarget}
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

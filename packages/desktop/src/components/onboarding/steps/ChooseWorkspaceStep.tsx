import { useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useState } from "react";
import { FolderOpen, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateProject, getListProjectsQueryKey, type Project } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { projectNameFromPath } from "@/hooks/useAddProjectAtPath";
import { desktopBridge } from "@/lib/desktop-bridge";
import { NewProjectOnboardingDialog } from "@/components/NewProjectOnboardingDialog";
import { useNewProjectOnboarding } from "@/lib/project-onboarding";
import { OnboardingFooter } from "../OnboardingFooter";
import { apiErrorMessage } from "@/lib/api-errors";
import type { OnboardingStepProps } from "../OnboardingOverlay";

/**
 * Step 3 — pick a folder on disk and turn it into a Cadencr project.
 *
 * Mirrors the "New Project" flow in `CommandPalette.tsx` (desktop folder
 * dialog → `useCreateProject`), keeping its own mutation for the inline
 * loading state and confirmation chip; the folder → name rule is shared.
 */
export function ChooseWorkspaceStep({
  isPersisting,
  onAdvance,
  onBack,
  onSkipStep,
}: OnboardingStepProps) {
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const [createdProject, setCreatedProject] = useState<Project | null>(null);
  const { onboardingProject, maybeOnboard, close: closeOnboarding } = useNewProjectOnboarding();

  const createProjectMutation = useCreateProject({
    mutation: {
      onSuccess: (project) => {
        setCreatedProject(project);
        void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        // The very first project is created here (not via the sidebar), so
        // trigger the same per-project onboarding modal unless opted out.
        maybeOnboard({ id: project.id, name: project.name });
      },
      onError: (err: unknown) => {
        const message = apiErrorMessage(err, t("common.unknownError", "Unknown error"));
        toast.error(
          t("onboarding.workspace.createError", "Could not create project: {{message}}", {
            message,
          }),
        );
      },
    },
  });

  const pickFolder = useCallback(async () => {
    const folder = await desktopBridge.pickDirectory();
    if (typeof folder !== "string") return;
    createProjectMutation.mutate({ data: { name: projectNameFromPath(folder), path: folder } });
  }, [createProjectMutation]);

  const isCreating = createProjectMutation.isPending;
  const primaryDisabled = isPersisting || isCreating;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onAdvance();
      }}
      className="flex flex-col gap-6"
    >
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">
          {t("onboarding.workspace.title", "Choose a project folder")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "onboarding.workspace.description",
            "Cadencr works on a folder on your machine. Pick the repository you want to use for your first session — you can add more later.",
          )}
        </p>
      </header>

      <FolderPickerCard
        createdProject={createdProject}
        isCreating={isCreating}
        onPickFolder={pickFolder}
      />

      <OnboardingFooter
        primaryLabel={t("common.continue", "Continue")}
        primaryDisabled={primaryDisabled}
        onBack={onBack}
        onSkipStep={onSkipStep}
        skipStepLabel={t("onboarding.workspace.later", "Do this later")}
      />

      {onboardingProject ? (
        <NewProjectOnboardingDialog
          projectId={onboardingProject.id}
          projectName={onboardingProject.name}
          open={true}
          onOpenChange={(open) => {
            if (!open) closeOnboarding();
          }}
        />
      ) : null}
    </form>
  );
}

function FolderPickerCard({
  createdProject,
  isCreating,
  onPickFolder,
}: {
  createdProject: Project | null;
  isCreating: boolean;
  onPickFolder: () => void;
}) {
  const { t } = useUiTranslation();
  return (
    <div className="rounded-md border border-border bg-muted/30 p-4 flex items-center gap-3">
      <FolderOpen className="size-5 text-muted-foreground" />
      <div className="flex-1 min-w-0 text-sm">
        {createdProject ? (
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-500" />
              <span className="font-medium">{createdProject.name}</span>
            </div>
            <code className="text-xs text-muted-foreground font-mono truncate block">
              {createdProject.path}
            </code>
          </div>
        ) : (
          <span className="text-muted-foreground">
            {t("onboarding.workspace.noFolder", "No folder selected yet.")}
          </span>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onPickFolder}
        disabled={isCreating}
      >
        {isCreating ? (
          <>
            <Loader2 className="size-3 animate-spin" />
            {t("onboarding.workspace.creating", "Creating…")}
          </>
        ) : createdProject ? (
          t("onboarding.workspace.another", "Choose another")
        ) : (
          t("onboarding.workspace.chooseFolder", "Choose folder…")
        )}
      </Button>
    </div>
  );
}

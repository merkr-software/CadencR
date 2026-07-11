import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetProjectSettings,
  useSetProjectSetting,
  getGetProjectSettingsQueryKey,
} from "@/api/generated";
import { settingsArrayToMap } from "@/api/settings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ProjectColorField } from "@/components/settings/ProjectColorField";
import {
  WorktreeSetupFields,
  type WorktreeSetupKey,
} from "@/components/settings/WorktreeSetupFields";
import { useProjectOnboardingDismissed } from "@/lib/project-onboarding";

type OnboardingSettingKey = "color" | WorktreeSetupKey;

/**
 * Lightweight onboarding shown right after a project is added: set the sidebar
 * color and the worktree defaults up front, so the user isn't dropped into a
 * project with no accent and no setup commands. Reuses the exact color picker
 * and worktree-setup inputs from Project Settings — everything autosaves, so
 * the footer button just closes. A "Don't show this again" checkbox suppresses
 * the modal for future project adds.
 */
export function NewProjectOnboardingDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
}: {
  projectId: number;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const { data: settingsArray } = useGetProjectSettings(projectId, { query: { enabled: open } });
  const settings = useMemo(() => settingsArrayToMap(settingsArray), [settingsArray]);

  const setSettingMutation = useSetProjectSetting({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetProjectSettingsQueryKey(projectId) });
      },
      onError: (err: Error) => {
        toast.error(err.message);
      },
    },
  });

  const { mutate: mutateSetting } = setSettingMutation;
  const saveProjectSetting = useCallback(
    (key: OnboardingSettingKey, value: string): void => {
      mutateSetting({ id: projectId, data: { key, value } });
    },
    [projectId, mutateSetting],
  );

  const { dismissed, setDismissed } = useProjectOnboardingDismissed();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border px-6 py-4 text-left">
          <DialogTitle className="text-base font-semibold">
            Set up <span className="text-muted-foreground">{projectName}</span>
          </DialogTitle>
          <DialogDescription>
            A couple of defaults for this project. Everything saves as you go and can be changed
            later in Project Settings.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
          <section>
            <ProjectColorField
              resetKeyPrefix={String(projectId)}
              color={settings.color}
              onSave={saveProjectSetting}
            />
          </section>

          <div className="border-t border-border" />

          <section className="space-y-5">
            <WorktreeSetupFields
              resetKeyPrefix={String(projectId)}
              branchPrefix={settings.branch_prefix}
              setupWorktree={settings.setup_worktree}
              onSave={saveProjectSetting}
              includeBranchPrefix={false}
            />
          </section>
        </div>

        <DialogFooter className="items-center justify-between border-t border-border px-6 py-4 sm:justify-between">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={dismissed} onCheckedChange={(next) => setDismissed(next === true)} />
            Don&apos;t show this for new projects
          </label>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

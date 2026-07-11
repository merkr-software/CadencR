import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetProjectSettings,
  useSetProjectSetting,
  getGetProjectSettingsQueryKey,
} from "../api/generated";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ModelSelector } from "./ModelSelector";
import { WorktreeList } from "./WorktreeList";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { ProjectColorField } from "@/components/settings/ProjectColorField";
import { ProjectJsonSettings } from "@/components/settings/SettingsJsonControls";
import { ProjectEditorToolingSettings } from "@/components/settings/ProjectEditorToolingSettings";
import { WorktreeSetupFields } from "@/components/settings/WorktreeSetupFields";
import { settingsArrayToMap } from "@/api/settings";

const PROJECT_SETTING_KEYS = {
  branchPrefix: "branch_prefix",
  color: "color",
  setupWorktree: "setup_worktree",
} as const;

type ProjectSettingKey = (typeof PROJECT_SETTING_KEYS)[keyof typeof PROJECT_SETTING_KEYS];

export function ProjectSettingsDialog({
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
  // Toast only the user-driven saves — the field-level autosave fires often
  // enough that a per-keystroke toast would be noise. We surface "Saved" on
  // explicit color picker clicks via the swatch's onChange.
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

  const saveProjectSetting = useCallback(
    (key: ProjectSettingKey, value: string): void => {
      setSettingMutation.mutate({ id: projectId, data: { key, value } });
    },
    [projectId, setSettingMutation],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[90vw] flex-col gap-0 p-0 sm:max-w-6xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-semibold">
            Project settings — <span className="text-muted-foreground">{projectName}</span>
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">Changes save automatically.</p>
        </DialogHeader>

        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
          <ConfigurationSection projectId={projectId} enabled={open} />
          <IdentitySection
            projectId={projectId}
            color={settings[PROJECT_SETTING_KEYS.color]}
            saveProjectSetting={saveProjectSetting}
          />
          <EditorToolingSection projectId={projectId} enabled={open} />
          <RuntimeModelsSection projectId={projectId} />
          <GitAutomationSection
            projectId={projectId}
            branchPrefix={settings[PROJECT_SETTING_KEYS.branchPrefix]}
            setupWorktree={settings[PROJECT_SETTING_KEYS.setupWorktree]}
            saveProjectSetting={saveProjectSetting}
          />
          <WorktreesSection projectId={projectId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConfigurationSection({
  projectId,
  enabled,
}: {
  projectId: number;
  enabled: boolean;
}): React.JSX.Element {
  return (
    <SettingsSection size="sm" title="Configuration" subtitle="Edit JSON · Copy path">
      <SettingsCard padded>
        <ProjectJsonSettings projectId={projectId} enabled={enabled} />
      </SettingsCard>
    </SettingsSection>
  );
}

function IdentitySection({
  projectId,
  color,
  saveProjectSetting,
}: {
  projectId: number;
  color: string | undefined;
  saveProjectSetting: (key: ProjectSettingKey, value: string) => void;
}): React.JSX.Element {
  return (
    <SettingsSection size="sm" title="Identity" subtitle="Color · Display">
      <SettingsCard padded>
        <ProjectColorField
          resetKeyPrefix={String(projectId)}
          color={color}
          onSave={saveProjectSetting}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function EditorToolingSection({
  projectId,
  enabled,
}: {
  projectId: number;
  enabled: boolean;
}): React.JSX.Element {
  return (
    <SettingsSection
      size="sm"
      title="Editor Tooling"
      subtitle="Language servers · Formatter"
      description="Type checker, linter, and formatter for this project's editor. Each falls back to the global default when unset."
    >
      <SettingsCard padded>
        <ProjectEditorToolingSettings projectId={projectId} enabled={enabled} />
      </SettingsCard>
    </SettingsSection>
  );
}

function RuntimeModelsSection({ projectId }: { projectId: number }): React.JSX.Element {
  return (
    <SettingsSection
      size="sm"
      title="Runtime & Models"
      subtitle="Per-agent model picks"
      description="Override the runtime/model used for each agent inside this project."
    >
      <SettingsCard>
        <ModelSelector level="project" projectId={projectId} />
      </SettingsCard>
    </SettingsSection>
  );
}

function GitAutomationSection({
  projectId,
  branchPrefix,
  setupWorktree,
  saveProjectSetting,
}: {
  projectId: number;
  branchPrefix: string | undefined;
  setupWorktree: string | undefined;
  saveProjectSetting: (key: ProjectSettingKey, value: string) => void;
}): React.JSX.Element {
  return (
    <SettingsSection
      size="sm"
      title="Git & Automation"
      subtitle="Worktree defaults"
      description="Defaults applied to worktrees created for this project."
    >
      <SettingsCard padded className="space-y-5">
        <WorktreeSetupFields
          resetKeyPrefix={String(projectId)}
          branchPrefix={branchPrefix}
          setupWorktree={setupWorktree}
          onSave={saveProjectSetting}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function WorktreesSection({ projectId }: { projectId: number }): React.JSX.Element {
  return (
    <SettingsSection
      size="sm"
      title="Worktrees"
      subtitle="Active checkouts"
      description="Git worktrees created for this project's features."
    >
      <SettingsCard padded>
        <WorktreeList projectId={projectId} />
      </SettingsCard>
    </SettingsSection>
  );
}

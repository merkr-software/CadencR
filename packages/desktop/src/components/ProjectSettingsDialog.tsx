import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Project,
  useGetProjectSettings,
  useSetProjectSetting,
  getGetProjectSettingsQueryKey,
} from "../api/generated";
import { PHONE_PAGE_DIALOG_CLASS } from "@/components/FullscreenDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";
import { WorktreeList } from "./WorktreeList";
import { CustomActionsManager } from "./custom-actions/CustomActionsManager";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { ProjectColorField } from "@/components/settings/ProjectColorField";
import { ProjectIconField } from "@/components/settings/ProjectIconField";
import { PROJECT_ICON_SETTING_KEY } from "@/lib/project-icon";
import { ProjectJsonSettings } from "@/components/settings/SettingsJsonControls";
import { ProjectEditorToolingSettings } from "@/components/settings/ProjectEditorToolingSettings";
import { WorktreeSetupFields } from "@/components/settings/WorktreeSetupFields";
import { settingsArrayToMap } from "@/api/settings";
import { ProviderPublicationPreparation } from "./ProviderPublicationPreparation";
import { ProviderPublicationPackagePreparation } from "./ProviderPublicationPackagePreparation";
import { ThemePublicationPackagePreparation } from "./ThemePublicationPackagePreparation";

const PROJECT_SETTING_KEYS = {
  branchPrefix: "branch_prefix",
  color: "color",
  iconPath: PROJECT_ICON_SETTING_KEY,
  setupWorktree: "setup_worktree",
} as const;

type ProjectSettingKey = (typeof PROJECT_SETTING_KEYS)[keyof typeof PROJECT_SETTING_KEYS];

export function ProjectSettingsDialog({
  projectId,
  projectName,
  authoringTarget,
  open,
  onOpenChange,
}: {
  projectId: number;
  projectName: string;
  authoringTarget?: Project["authoring_target"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  // A page on a phone, not a box over the drawer.
  const phone = useIsMobile();
  const { settings, saveProjectSetting } = useProjectSettingsState(projectId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex flex-col gap-0 p-0",
          phone
            ? PHONE_PAGE_DIALOG_CLASS
            : "max-h-[min(85vh,var(--dialog-max-h))] w-[90vw] sm:max-w-6xl",
        )}
      >
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-semibold">
            <UiTrans
              i18nKey="project.settingsDialog.title"
              defaults="Project settings — <project>{{name}}</project>"
              components={{ project: <span className="text-muted-foreground" /> }}
              values={{ name: projectName }}
            />
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">
            {t("project.settingsDialog.changesSaveAutomatically", "Changes save automatically.")}
          </p>
        </DialogHeader>

        <div
          className={cn(
            "flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6",
            phone && "px-4 py-4",
          )}
        >
          <ConfigurationSection projectId={projectId} enabled={open} />
          <PublicationSection projectId={projectId} enabled={open} target={authoringTarget} />
          <IdentitySection
            projectId={projectId}
            color={settings[PROJECT_SETTING_KEYS.color]}
            iconPath={settings[PROJECT_SETTING_KEYS.iconPath]}
            saveProjectSetting={saveProjectSetting}
          />
          <SettingsSection
            size="sm"
            title={t("project.settingsDialog.customActions", "Custom actions")}
            subtitle={t("project.settingsDialog.headerLauncher", "Header launcher")}
            description={t(
              "project.settingsDialog.customActionsDescription",
              "This project's own actions, shown in its header before the global ones (Settings → Custom actions).",
            )}
          >
            <SettingsCard padded>
              <CustomActionsManager scope="project" projectId={projectId} />
            </SettingsCard>
          </SettingsSection>
          <EditorToolingSection projectId={projectId} enabled={open} />
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

function PublicationSection({
  projectId,
  enabled,
  target,
}: {
  projectId: number;
  enabled: boolean;
  target: Project["authoring_target"];
}): React.JSX.Element | null {
  return target === "provider" ? (
    <>
      <ProviderPublicationPreparation projectId={projectId} enabled={enabled} />
      <ProviderPublicationPackagePreparation projectId={projectId} enabled={enabled} />
    </>
  ) : target === "theme" || target === "tab" ? (
    <>
      <ProviderPublicationPreparation projectId={projectId} enabled={enabled} pluginKind={target} />
      <ThemePublicationPackagePreparation
        projectId={projectId}
        enabled={enabled}
        pluginKind={target}
      />
    </>
  ) : null;
}

/** The project's settings while the dialog is open, and the autosave of one. */
function useProjectSettingsState(
  projectId: number,
  open: boolean,
): {
  settings: ReturnType<typeof settingsArrayToMap>;
  saveProjectSetting: (key: ProjectSettingKey, value: string) => void;
} {
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
  return { settings, saveProjectSetting };
}

function ConfigurationSection({
  projectId,
  enabled,
}: {
  projectId: number;
  enabled: boolean;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <SettingsSection
      size="sm"
      title={t("project.settingsDialog.configuration", "Configuration")}
      subtitle={t("project.settingsDialog.editJsonCopyPath", "Edit JSON · Copy path")}
    >
      <SettingsCard padded>
        <ProjectJsonSettings projectId={projectId} enabled={enabled} />
      </SettingsCard>
    </SettingsSection>
  );
}

function IdentitySection({
  projectId,
  color,
  iconPath,
  saveProjectSetting,
}: {
  projectId: number;
  color: string | undefined;
  iconPath: string | undefined;
  saveProjectSetting: (key: ProjectSettingKey, value: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <SettingsSection
      size="sm"
      title={t("project.settingsDialog.identity", "Identity")}
      subtitle={t("project.settingsDialog.colorIconDisplay", "Color · Icon · Display")}
    >
      <SettingsCard padded>
        <div className="space-y-5">
          <ProjectColorField
            resetKeyPrefix={String(projectId)}
            color={color}
            onSave={saveProjectSetting}
          />
          <div className="border-t border-border" />
          <ProjectIconField projectId={projectId} iconPath={iconPath} onSave={saveProjectSetting} />
        </div>
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
  const { t } = useUiTranslation();
  return (
    <SettingsSection
      size="sm"
      title={t("project.settingsDialog.editorTooling", "Editor Tooling")}
      subtitle={t(
        "project.settingsDialog.languageServersFormatter",
        "Language servers · Formatter",
      )}
      description={t(
        "project.settingsDialog.editorToolingDescription",
        "Type checker, linter, and formatter for this project's editor. Each falls back to the global default when unset.",
      )}
    >
      <SettingsCard padded>
        <ProjectEditorToolingSettings projectId={projectId} enabled={enabled} />
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
  const { t } = useUiTranslation();
  return (
    <SettingsSection
      size="sm"
      title={t("project.settingsDialog.gitAutomation", "Git & Automation")}
      subtitle={t("project.settingsDialog.worktreeDefaults", "Worktree defaults")}
      description={t(
        "project.settingsDialog.worktreeDefaultsDescription",
        "Defaults applied to worktrees created for this project.",
      )}
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
  const { t } = useUiTranslation();
  return (
    <SettingsSection
      size="sm"
      title={t("project.settingsDialog.worktrees", "Worktrees")}
      subtitle={t("project.settingsDialog.activeCheckouts", "Active checkouts")}
      description={t(
        "project.settingsDialog.worktreesDescription",
        "Git worktrees created for this project's features.",
      )}
    >
      <SettingsCard padded>
        <WorktreeList projectId={projectId} />
      </SettingsCard>
    </SettingsSection>
  );
}

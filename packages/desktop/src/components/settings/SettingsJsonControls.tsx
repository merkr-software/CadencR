import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { lazy, Suspense, useState } from "react";
import { Code2, Copy, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { SettingsJsonDialogShell } from "./SettingsJsonDialogShell";
import {
  useGetSettingsFile,
  usePutSettingsFile,
  useGetProjectSettingsFile,
  usePutProjectSettingsFile,
  type SettingWarning,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { invalidateSettingsDerivedQueries } from "@/lib/settingsInvalidation";
import { SettingsWarningsBanner } from "./SettingsWarningsBanner";

const SettingsJsonEditorDialog = lazy(() => import("./SettingsJsonEditorDialog"));

/**
 * Suspense fallback shown while the CodeMirror editor chunk loads. Renders the
 * dialog shell immediately with a spinner so clicking "Edit JSON" never leaves
 * the user staring at a frozen screen.
 */
function EditorLoadingDialog({
  title,
  path,
  onOpenChange,
}: {
  title: string;
  path?: string;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <SettingsJsonDialogShell title={title} path={path} onOpenChange={onOpenChange}>
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Loader2
          className="size-5 animate-spin"
          aria-label={t("settings.general.json.loading", "Loading editor")}
        />
      </div>
    </SettingsJsonDialogShell>
  );
}

interface SettingsJsonControlsProps {
  title: string;
  path?: string;
  content?: string;
  warnings: SettingWarning[];
  isLoading: boolean;
  isSaving: boolean;
  onSave: (content: string) => Promise<SettingWarning[]>;
  onSaved: () => void;
}

/** Presentational "Edit JSON" / "Copy configuration path" row + warnings. */
function SettingsJsonControls({
  title,
  path,
  content,
  warnings,
  isLoading,
  isSaving,
  onSave,
  onSaved,
}: SettingsJsonControlsProps): React.JSX.Element {
  const { t } = useUiTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2.5">
      {/* On a phone the path takes the full width and the buttons go under it. */}
      <div className="flex items-center justify-between gap-2 phone:flex-col phone:items-stretch">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {t("settings.general.json.file", "Configuration file")}
          </div>
          <p className="truncate text-xs text-muted-foreground phone:break-all phone:whitespace-normal">
            {path ??
              t("settings.general.json.description", "Edit these settings directly as JSON.")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 phone:[&>*]:min-h-11 phone:[&>*]:flex-1">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isLoading || content == null}
            onClick={() => setOpen(true)}
          >
            <Code2 className="size-3.5" />
            {t("settings.general.json.edit", "Edit JSON")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!path}
            onClick={() =>
              path &&
              void copyToClipboard(
                path,
                translateUi("settings.general.json.pathCopied", "Configuration path copied"),
              )
            }
          >
            <Copy className="size-3.5" />
            {t("settings.general.json.copyPath", "Copy path")}
          </Button>
        </div>
      </div>

      <SettingsWarningsBanner warnings={warnings} />

      {open && content != null ? (
        <Suspense
          fallback={<EditorLoadingDialog title={title} path={path} onOpenChange={setOpen} />}
        >
          <SettingsJsonEditorDialog
            open
            onOpenChange={setOpen}
            title={title}
            path={path}
            initialContent={content}
            isSaving={isSaving}
            onSave={onSave}
            onSaved={onSaved}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

/** Global/workspace settings JSON controls. */
export function WorkspaceJsonSettings(): React.JSX.Element {
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetSettingsFile();
  const put = usePutSettingsFile();
  return (
    <SettingsJsonControls
      title={t("settings.general.json.globalTitle", "Global settings")}
      path={data?.path}
      content={data?.content}
      warnings={data?.warnings ?? []}
      isLoading={isLoading}
      isSaving={put.isPending}
      onSave={async (content) => (await put.mutateAsync({ data: { content } })).warnings}
      onSaved={() => void invalidateSettingsDerivedQueries(queryClient)}
    />
  );
}

/** Per-project settings JSON controls. `enabled` gates the fetch (dialog open). */
export function ProjectJsonSettings({
  projectId,
  enabled = true,
}: {
  projectId: number;
  enabled?: boolean;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetProjectSettingsFile(projectId, { query: { enabled } });
  const put = usePutProjectSettingsFile();
  return (
    <SettingsJsonControls
      title={t("settings.general.json.projectTitle", "Project settings")}
      path={data?.path}
      content={data?.content}
      warnings={data?.warnings ?? []}
      isLoading={isLoading}
      isSaving={put.isPending}
      onSave={async (content) =>
        (await put.mutateAsync({ id: projectId, data: { content } })).warnings
      }
      onSaved={() => void invalidateSettingsDerivedQueries(queryClient)}
    />
  );
}

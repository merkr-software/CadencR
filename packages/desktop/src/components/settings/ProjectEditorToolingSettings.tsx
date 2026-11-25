import { useUiTranslation } from "@/lib/i18n/ui";
/**
 * Per-project editor tooling pickers (Phase 4): TypeScript server, linter,
 * formatter, and format-on-save. Each falls back to the workspace-scoped global
 * default when unset on the project; the control shows the effective value.
 *
 * Three dropdowns on one row rather than three stacked card grids: eleven
 * option cards spent most of the Project settings dialog on choices that are
 * set once and never revisited. The hint under each control keeps describing
 * the *selected* option, so compacting the picker doesn't cost the explanation
 * of what is currently running.
 *
 * Writes go to `PUT /api/projects/{id}/settings` (project scope). The global
 * defaults live on the Settings → Editor page (workspace scope).
 */
import type { ReactElement } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { getGetProjectSettingsQueryKey, useSetProjectSetting } from "@/api/generated";
import { useProjectEditorTooling } from "@/lib/lsp/useProjectEditorTooling";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCompactCombo } from "@/lib/shortcuts/format";
import { getRegistryShortcut } from "@/lib/shortcuts/resolve";
import { LabeledControl } from "./LabeledControl";
import { LanguageServerSettings } from "./LanguageServerSettings";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

interface ToolingOption {
  value: string;
  label: string;
  description: string;
}

const FORMAT_DOCUMENT_COMBO = formatCompactCombo(
  getRegistryShortcut("editor-format-document").keys,
);

function useFormatterOptions(): readonly ToolingOption[] {
  const { t } = useUiTranslation();
  const combo = FORMAT_DOCUMENT_COMBO;
  return [
    {
      value: "off",
      label: t("project.editorToolingSettings.off", "Off"),
      description: t(
        "project.editorToolingSettings.noFormatterDescription",
        "No formatter — “Format document” ({{combo}}) does nothing.",
        { combo },
      ),
    },
    {
      value: "biome",
      label: "Biome",
      description: t(
        "project.editorToolingSettings.biomeDescription",
        "biome format, via “Format document” ({{combo}}).",
        { combo },
      ),
    },
    {
      value: "oxfmt",
      label: "oxfmt",
      description: t(
        "project.editorToolingSettings.oxfmtDescription",
        "oxc formatter, via “Format document” ({{combo}}).",
        { combo },
      ),
    },
    {
      value: "prettier",
      label: "Prettier",
      description: t(
        "project.editorToolingSettings.prettierDescription",
        "prettier --stdin-filepath, via “Format document” ({{combo}}).",
        { combo },
      ),
    },
  ];
}

export function ProjectEditorToolingSettings({
  projectId,
  enabled,
}: {
  projectId: number;
  enabled: boolean;
}): ReactElement {
  const { t } = useUiTranslation();
  const options = useFormatterOptions();
  const queryClient = useQueryClient();
  const tooling = useProjectEditorTooling(enabled ? projectId : undefined);

  const setSetting = useSetProjectSetting({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getGetProjectSettingsQueryKey(projectId),
        });
      },
      onError: (err: Error) => {
        toast.error(err.message);
      },
    },
  });

  const update = (key: string, value: string): void => {
    setSetting.mutate({ id: projectId, data: { key, value } });
  };

  return (
    <div className="space-y-4">
      {enabled && <LanguageServerSettings projectId={projectId} />}
      <div className="grid gap-4">
        <ToolingSelect
          label={t("project.editorToolingSettings.formatter", "Formatter")}
          value={tooling.formatter}
          options={options}
          disabled={setSetting.isPending}
          onChange={(next) => update("editor_formatter", next)}
        />
      </div>

      <SettingsSwitchRow
        label={t("project.editorToolingSettings.formatOnSave", "Format on save")}
        description={t(
          "project.editorToolingSettings.formatOnSaveDescription",
          "Run the configured formatter every time the buffer is saved.",
        )}
        checked={tooling.formatOnSave}
        onCheckedChange={(next) => update("editor_format_on_save", next ? "true" : "false")}
        disabled={setSetting.isPending || tooling.formatter === "off"}
        divided
      />
    </div>
  );
}

function ToolingSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly ToolingOption[];
  disabled: boolean;
  onChange: (next: string) => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const selected = options.find((option) => option.value === value);
  // Settings are hand-editable JSON, so the persisted value can be something we
  // don't ship an option for. Surface it as its own entry instead of rendering
  // an empty trigger the user can only fix by overwriting it blind.
  const items = selected
    ? options
    : [
        ...options,
        {
          value,
          label: value,
          description: t(
            "project.editorToolingSettings.unknownValue",
            "Not a value Cadencr recognizes.",
          ),
        },
      ];
  return (
    <LabeledControl label={label} hint={selected?.description ?? items.at(-1)?.description}>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger size="sm" className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </LabeledControl>
  );
}

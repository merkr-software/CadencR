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
import { SettingsSwitchRow } from "./SettingsSwitchRow";

interface ToolingOption {
  value: string;
  label: string;
  description: string;
}

const FORMAT_DOCUMENT_COMBO = formatCompactCombo(
  getRegistryShortcut("editor-format-document").keys,
);

const TS_SERVER_OPTIONS: readonly ToolingOption[] = [
  {
    value: "typescript-language-server",
    label: "typescript-language-server",
    description: "Standard TS/JS server (default).",
  },
  { value: "tsgo", label: "tsgo", description: "Go-native TypeScript preview server." },
];

const LINTER_OPTIONS: readonly ToolingOption[] = [
  { value: "off", label: "Off", description: "No linter." },
  { value: "eslint", label: "ESLint", description: "vscode-eslint-language-server." },
  { value: "biome", label: "Biome", description: "Biome lint diagnostics." },
  { value: "oxlint", label: "oxlint", description: "Fast Rust-based linter." },
];

const FORMATTER_OPTIONS: readonly ToolingOption[] = [
  {
    value: "off",
    label: "Off",
    description: `No formatter — “Format document” (${FORMAT_DOCUMENT_COMBO}) does nothing.`,
  },
  {
    value: "biome",
    label: "Biome",
    description: `biome format, via “Format document” (${FORMAT_DOCUMENT_COMBO}).`,
  },
  {
    value: "oxfmt",
    label: "oxfmt",
    description: `oxc formatter, via “Format document” (${FORMAT_DOCUMENT_COMBO}).`,
  },
  {
    value: "prettier",
    label: "Prettier",
    description: `prettier --stdin-filepath, via “Format document” (${FORMAT_DOCUMENT_COMBO}).`,
  },
];

export function ProjectEditorToolingSettings({
  projectId,
  enabled,
}: {
  projectId: number;
  enabled: boolean;
}): ReactElement {
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
      <div className="grid gap-4 sm:grid-cols-3">
        <ToolingSelect
          label="TypeScript server"
          value={tooling.typescriptServer}
          options={TS_SERVER_OPTIONS}
          disabled={setSetting.isPending}
          onChange={(next) => update("editor_typescript_server", next)}
        />
        <ToolingSelect
          label="Linter"
          value={tooling.linter}
          options={LINTER_OPTIONS}
          disabled={setSetting.isPending}
          onChange={(next) => update("editor_linter", next)}
        />
        <ToolingSelect
          label="Formatter"
          value={tooling.formatter}
          options={FORMATTER_OPTIONS}
          disabled={setSetting.isPending}
          onChange={(next) => update("editor_formatter", next)}
        />
      </div>

      <SettingsSwitchRow
        label="Format on save"
        description="Run the configured formatter every time the buffer is saved."
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
  const selected = options.find((option) => option.value === value);
  // Settings are hand-editable JSON, so the persisted value can be something we
  // don't ship an option for. Surface it as its own entry instead of rendering
  // an empty trigger the user can only fix by overwriting it blind.
  const items = selected
    ? options
    : [...options, { value, label: value, description: "Not a value Cadencr recognizes." }];
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

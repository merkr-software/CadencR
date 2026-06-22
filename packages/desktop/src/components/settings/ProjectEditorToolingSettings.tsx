/**
 * Per-project editor tooling pickers (Phase 4): TypeScript server, linter,
 * formatter, and format-on-save. Each falls back to the workspace-scoped global
 * default when unset on the project; the radio shows the effective value.
 *
 * Writes go to `PUT /api/projects/{id}/settings` (project scope). The global
 * defaults live on the Settings → Editor page (workspace scope).
 */
import type { ReactElement } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { getGetProjectSettingsQueryKey, useSetProjectSetting } from "@/api/generated";
import { useProjectEditorTooling } from "@/lib/lsp/useProjectEditorTooling";
import { RadioCardGroup, type RadioCardOption } from "./RadioCardGroup";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const TS_SERVER_OPTIONS: ReadonlyArray<RadioCardOption<string>> = [
  {
    value: "typescript-language-server",
    label: "typescript-language-server",
    description: "Standard TS/JS server (default).",
  },
  { value: "tsgo", label: "tsgo", description: "Go-native TypeScript preview server." },
];

const LINTER_OPTIONS: ReadonlyArray<RadioCardOption<string>> = [
  { value: "off", label: "Off", description: "No linter." },
  { value: "eslint", label: "ESLint", description: "vscode-eslint-language-server." },
  { value: "biome", label: "Biome", description: "Biome lint diagnostics." },
  { value: "oxlint", label: "oxlint", description: "Fast Rust-based linter." },
];

const FORMATTER_OPTIONS: ReadonlyArray<RadioCardOption<string>> = [
  { value: "off", label: "Off", description: "No formatter." },
  { value: "biome", label: "Biome", description: "biome format." },
  { value: "oxfmt", label: "oxfmt", description: "oxc formatter." },
  { value: "prettier", label: "Prettier", description: "prettier --stdin-filepath." },
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
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="text-sm font-medium">TypeScript server</div>
        <p className="text-xs text-muted-foreground">
          Language server for TypeScript / JavaScript files.
        </p>
        <RadioCardGroup<string>
          ariaLabel="TypeScript server"
          value={tooling.typescriptServer}
          onChange={(next) => update("editor_typescript_server", next)}
          options={TS_SERVER_OPTIONS}
          layout="grid"
          disabled={setSetting.isPending}
        />
      </div>

      <div className="border-t border-border" />

      <div className="space-y-2">
        <div className="text-sm font-medium">Linter</div>
        <p className="text-xs text-muted-foreground">
          Runs alongside the type checker; its diagnostics are merged in.
        </p>
        <RadioCardGroup<string>
          ariaLabel="Linter"
          value={tooling.linter}
          onChange={(next) => update("editor_linter", next)}
          options={LINTER_OPTIONS}
          layout="grid"
          disabled={setSetting.isPending}
        />
      </div>

      <div className="border-t border-border" />

      <div className="space-y-2">
        <div className="text-sm font-medium">Formatter</div>
        <p className="text-xs text-muted-foreground">
          Used by “Format document” (⌘⇧I) and format-on-save.
        </p>
        <RadioCardGroup<string>
          ariaLabel="Formatter"
          value={tooling.formatter}
          onChange={(next) => update("editor_formatter", next)}
          options={FORMATTER_OPTIONS}
          layout="grid"
          disabled={setSetting.isPending}
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

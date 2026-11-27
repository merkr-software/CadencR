import { useUiTranslation } from "@/lib/i18n/ui";
import { useLspResolution } from "@/lib/lsp/useLspResolution";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LabeledControl } from "./LabeledControl";
import type { Choice, Server } from "./LanguageServerSettings";

export function LanguageChoices({
  projectId,
  language,
  choice,
  save,
  saving,
}: {
  projectId?: number;
  language: string;
  choice: Choice;
  save: (choice: Choice) => void;
  saving: boolean;
}) {
  const { t } = useUiTranslation();
  const resolved = useLspResolution({ language_id: language, project_id: projectId });
  const candidates = resolved.data?.candidates ?? [];
  const primary =
    choice.primary === undefined ? "inherit" : choice.primary === null ? "off" : choice.primary;
  const primaries = candidates.filter(
    (server) => server.role === "type_checker" || server.role === "general",
  );
  const linters = candidates.filter((server) => server.role === "linter");
  const effective = resolved.data?.primary ?? t("workspace.editor.languageServers.off", "Off");
  const selectedLinters = choice.linters ?? resolved.data?.linters ?? [];
  const extra =
    primary !== "inherit" &&
    primary !== "off" &&
    !primaries.some((server) => server.lsp_id === primary);
  return (
    <div className="space-y-3">
      <PrimaryLanguageServer
        primary={primary}
        primaries={primaries}
        isGlobal={projectId === undefined}
        effective={effective}
        extra={extra}
        choice={choice}
        saving={saving || resolved.isPending}
        save={save}
      />
      <LinterChoices
        choice={choice}
        save={save}
        saving={saving || resolved.isPending}
        linters={linters}
        selectedLinters={selectedLinters}
        projectId={projectId}
      />
      {resolved.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          {t(
            "workspace.editor.languageServers.resolvingLanguageChoices",
            "Resolving language choices…",
          )}
        </p>
      )}
      {resolved.data?.catalog_warning && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("workspace.editor.languageServers.catalogWarning", "Catalog: {{warning}}", {
            warning: resolved.data.catalog_warning,
          })}
        </p>
      )}
      {(resolved.error || resolved.data?.error) && (
        <p role="alert" className="text-xs text-destructive">
          {resolved.error?.message ?? resolved.data?.error}
        </p>
      )}
    </div>
  );
}

function LinterChoices({
  choice,
  save,
  saving,
  linters,
  selectedLinters,
  projectId,
}: {
  choice: Choice;
  save: (choice: Choice) => void;
  saving: boolean;
  linters: Server[];
  selectedLinters: string[];
  projectId?: number;
}) {
  const { t } = useUiTranslation();
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">
        {t("workspace.editor.languageServers.linters", "Linters")}
      </p>
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={choice.linters === undefined}
          disabled={saving}
          onCheckedChange={(checked) => {
            const next = { ...choice };
            if (checked) delete next.linters;
            else next.linters = [...selectedLinters];
            save(next);
          }}
        />
        {projectId === undefined
          ? t("workspace.editor.languageServers.defaultLinters", "Use default (no linters)")
          : t("workspace.editor.languageServers.inheritLinters", "Inherit global linters")}
      </label>
      {linters.map((server) => (
        <label key={server.lsp_id} className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={selectedLinters.includes(server.lsp_id)}
            disabled={saving}
            onCheckedChange={(checked) =>
              save({
                ...choice,
                linters: checked
                  ? [...new Set([...selectedLinters, server.lsp_id])]
                  : selectedLinters.filter((id) => id !== server.lsp_id),
              })
            }
          />
          {server.name}
        </label>
      ))}
      {selectedLinters
        .filter((id) => !linters.some((server) => server.lsp_id === id))
        .map((id) => (
          <label key={id} className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked
              disabled={saving}
              onCheckedChange={() =>
                save({ ...choice, linters: selectedLinters.filter((selected) => selected !== id) })
              }
            />
            {t(
              "workspace.editor.languageServers.missingLinter",
              "{{server}} (saved, not installed)",
              { server: id },
            )}
          </label>
        ))}
    </div>
  );
}

function PrimaryLanguageServer({
  primary,
  primaries,
  isGlobal,
  effective,
  extra,
  choice,
  saving,
  save,
}: {
  primary: string;
  primaries: Server[];
  isGlobal: boolean;
  effective: string;
  extra: boolean;
  choice: Choice;
  saving: boolean;
  save: (choice: Choice) => void;
}) {
  const { t } = useUiTranslation();
  return (
    <LabeledControl
      label={t("workspace.editor.languageServers.primaryServer", "Primary server")}
      hint={
        isGlobal
          ? t(
              "workspace.editor.languageServers.effectiveAutomatic",
              "Effective: {{server}}. Automatic uses the only installed compatible primary server; choose one when several are installed.",
              {
                server: effective,
              },
            )
          : t(
              "workspace.editor.languageServers.effectiveInherited",
              "Effective: {{server}}. Inherit uses the global default.",
              {
                server: effective,
              },
            )
      }
    >
      <Select
        value={primary}
        disabled={saving}
        onValueChange={(value) => {
          const next = { ...choice };
          if (value === "inherit") delete next.primary;
          else next.primary = value === "off" ? null : value;
          save(next);
        }}
      >
        <SelectTrigger
          size="sm"
          aria-label={t(
            "workspace.editor.languageServers.primaryLanguageServer",
            "Primary language server",
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">
            {isGlobal
              ? t("workspace.editor.languageServers.automatic", "Automatic")
              : t("workspace.editor.languageServers.inheritPrimary", "Inherit global default")}
          </SelectItem>
          <SelectItem value="off">{t("workspace.editor.languageServers.off", "Off")}</SelectItem>
          {primaries.map((server) => (
            <SelectItem key={server.lsp_id} value={server.lsp_id}>
              {server.name}
            </SelectItem>
          ))}
          {extra && (
            <SelectItem value={primary}>
              {t("workspace.editor.languageServers.missingPrimary", "{{server}} (not installed)", {
                server: primary,
              })}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
    </LabeledControl>
  );
}

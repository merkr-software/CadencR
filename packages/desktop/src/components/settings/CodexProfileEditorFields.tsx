import { Plus, Trash2 } from "lucide-react";
import type { CodexProfileSummary, CodexProfileValidation } from "@/api/codexProfiles";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { Loader2 } from "lucide-react";

export interface EnvRow {
  id: number;
  key: string;
  value: string;
  preserved: boolean;
}
let nextEnvRowId = 0;
export function createEnvRow(key = "", value = "", preserved = false): EnvRow {
  return { id: nextEnvRowId++, key, value, preserved };
}

export function EditorFields({
  initial,
  name,
  setName,
  configPath,
  setConfigPath,
  envRows,
  setEnvRows,
  unsetRows,
  setUnsetRows,
  localError,
  validation,
}: {
  initial?: CodexProfileSummary;
  name: string;
  setName: (value: string) => void;
  configPath: string;
  setConfigPath: (value: string) => void;
  envRows: EnvRow[];
  setEnvRows: React.Dispatch<React.SetStateAction<EnvRow[]>>;
  unsetRows: string[];
  setUnsetRows: React.Dispatch<React.SetStateAction<string[]>>;
  localError: string | null;
  validation: CodexProfileValidation | undefined;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-2 pr-1">
      <Field
        label={t("settings.providers.codexProfileEditor.name", "Name")}
        htmlFor="codex-profile-label"
      >
        <Input
          id="codex-profile-label"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("settings.providers.codexProfileEditor.workAccount", "Work account")}
        />
      </Field>
      <Field
        label={t(
          "settings.providers.codexProfileEditor.sourceConfigTomlOptional",
          "Source {{file}} (optional)",
          { file: "config.toml" },
        )}
        htmlFor="codex-profile-config"
      >
        <Input
          id="codex-profile-config"
          className="font-mono text-xs"
          value={configPath}
          onChange={(event) => setConfigPath(event.target.value)}
          placeholder="/Users/me/.codex/config.toml"
        />
        <p className="text-xs text-muted-foreground">
          <UiTrans
            i18nKey="settings.providers.codexProfileEditor.customConfigHelp"
            defaults={
              "Leave blank to use your usual Codex home and configuration. To use a custom file, enter an absolute path ending literally in <code>{{file}}</code>; its parent becomes the isolated <code>{{homeVariable}}</code>. A custom home has separate authentication, history, and state, so you may need to sign in again. Cadencr never edits the source file."
            }
            components={{ code: <code /> }}
            values={{ file: "config.toml", homeVariable: "CODEX_HOME" }}
          />
        </p>
      </Field>
      <KeyValueRows rows={envRows} setRows={setEnvRows} />
      <StringRows
        label={t(
          "settings.providers.codexProfileEditor.removeInheritedEnvironmentVariables",
          "Remove inherited environment variables",
        )}
        rows={unsetRows}
        setRows={setUnsetRows}
        placeholder={"OPENAI_API_KEY"}
      />
      <ValidationReport
        effectiveHome={initial?.effective_home}
        localError={localError}
        validation={validation}
      />
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function KeyValueRows({
  rows,
  setRows,
}: {
  rows: EnvRow[];
  setRows: React.Dispatch<React.SetStateAction<EnvRow[]>>;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <Field
      label={t(
        "settings.providers.codexProfileEditor.environmentVariables",
        "Environment variables",
      )}
    >
      {rows.map((row, index) => (
        <div key={row.id} className="flex gap-2">
          <Input
            className="font-mono text-xs"
            value={row.key}
            placeholder={"OPENAI_BASE_URL"}
            onChange={(event) =>
              setRows((all) =>
                all.map((item, i) =>
                  i === index ? { ...item, key: event.target.value, preserved: false } : item,
                ),
              )
            }
          />
          <Input
            className="font-mono text-xs"
            type="password"
            value={row.value}
            placeholder={
              row.preserved
                ? t(
                    "settings.providers.codexProfileEditor.storedValueLeaveBlankToPreserve",
                    "Stored value (leave blank to preserve)",
                  )
                : t("settings.providers.codexProfileEditor.value", "Value")
            }
            onChange={(event) =>
              setRows((all) =>
                all.map((item, i) =>
                  i === index ? { ...item, value: event.target.value, preserved: false } : item,
                ),
              )
            }
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t(
              "settings.providers.codexProfileEditor.removeEnvironmentValue",
              "Remove environment value",
            )}
            onClick={() => setRows((all) => all.filter((_, i) => i !== index))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setRows((all) => [...all, createEnvRow()])}
      >
        <Plus className="size-3.5" /> {t("settings.providers.codexProfileEditor.addRow", "Add row")}
      </Button>
    </Field>
  );
}

function StringRows({
  label,
  rows,
  setRows,
  placeholder,
}: {
  label: string;
  rows: string[];
  setRows: React.Dispatch<React.SetStateAction<string[]>>;
  placeholder: string;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <Field label={label}>
      {rows.map((row, index) => (
        <div key={index} className="flex gap-2">
          <Input
            className="font-mono text-xs"
            value={row}
            placeholder={placeholder}
            onChange={(event) =>
              setRows((all) => all.map((item, i) => (i === index ? event.target.value : item)))
            }
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t(
              "settings.providers.codexProfileEditor.removeUnsetVariable",
              "Remove unset variable",
            )}
            onClick={() => setRows((all) => all.filter((_, i) => i !== index))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => setRows((all) => [...all, ""])}>
        <Plus className="size-3.5" />{" "}
        {t("settings.providers.codexProfileEditor.addVariable", "Add variable")}
      </Button>
    </Field>
  );
}

function ValidationReport({
  effectiveHome,
  localError,
  validation,
}: {
  effectiveHome: string | null | undefined;
  localError: string | null;
  validation: CodexProfileValidation | undefined;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <>
      {effectiveHome && (
        <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
          {t(
            "settings.providers.codexProfileEditor.effectiveHome",
            "Effective {{variable}}: {{path}}",
            { variable: "CODEX_HOME", path: effectiveHome },
          )}
        </p>
      )}
      {localError && <p className="text-xs text-destructive">{localError}</p>}
      {validation && !validation.valid && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-destructive">
          {validation.errors.map((error) => (
            <li key={`${error.field}:${error.code}`}>{error.message}</li>
          ))}
        </ul>
      )}
      {validation?.valid && validation.effective_home && (
        <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
          {t(
            "settings.providers.codexProfileEditor.validatedHome",
            "Validated {{variable}}: {{path}}",
            { variable: "CODEX_HOME", path: validation.effective_home },
          )}
        </p>
      )}
    </>
  );
}

export function EditorHeader({ name }: { name?: string }) {
  const { t } = useUiTranslation();
  return (
    <DialogHeader className="shrink-0">
      <DialogTitle
        className="truncate"
        title={
          name
            ? t("settings.providers.codexProfileEditor.editTitle", "Edit profile “{{name}}”", {
                name: name,
              })
            : undefined
        }
      >
        {name
          ? t("settings.providers.codexProfileEditor.editTitle", "Edit profile “{{name}}”", {
              name: name,
            })
          : t("settings.providers.codexProfileEditor.newTitle", "New profile")}
      </DialogTitle>
      <DialogDescription>
        {t(
          "settings.providers.codexProfileEditor.valuesAreStoredInCadencrSLocalSettings",
          "Values are stored in Cadencr’s local settings, not an encrypted vault. Profile list and edit responses mask them. Leave an existing value blank to preserve it; remove its row to delete it.",
        )}
      </DialogDescription>
    </DialogHeader>
  );
}

export function EditorFooter({
  canSubmit,
  isValidating,
  isSaving,
  onClose,
  onValidate,
  onSave,
}: {
  canSubmit: boolean;
  isValidating: boolean;
  isSaving: boolean;
  onClose: () => void;
  onValidate: () => void;
  onSave: () => void;
}) {
  const { t } = useUiTranslation();
  return (
    <DialogFooter className="shrink-0">
      <Button variant="ghost" onClick={onClose}>
        {t("settings.providers.codexProfileEditor.cancel", "Cancel")}
      </Button>
      <Button
        variant="outline"
        disabled={!canSubmit}
        onClick={onValidate}
        title={t(
          "settings.providers.codexProfileEditor.checksLocalPathsEnvironmentKeysAndToml",
          "Checks local paths, environment keys, and TOML syntax; it does not prove Codex compatibility.",
        )}
      >
        {isValidating ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {t("settings.providers.codexProfileEditor.validate", "Validate")}
      </Button>
      <Button disabled={!canSubmit} onClick={onSave}>
        {isSaving ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {t("settings.providers.codexProfileEditor.save", "Save profile")}
      </Button>
    </DialogFooter>
  );
}

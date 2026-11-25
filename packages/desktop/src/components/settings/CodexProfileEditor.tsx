import {
  createEnvRow,
  EditorFields,
  EditorFooter,
  EditorHeader,
  type EnvRow,
} from "./CodexProfileEditorFields";
import { translateUi, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  useSaveCodexProfile,
  useValidateCodexProfile,
  type CodexProfileDraft,
  type CodexProfileSummary,
} from "@/api/codexProfiles";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api-errors";

export function CodexProfileEditor({
  initial,
  onClose,
}: {
  initial?: CodexProfileSummary;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const save = useSaveCodexProfile();
  const validate = useValidateCodexProfile();
  const [name, setName] = useState(initial?.name ?? "");
  const [configPath, setConfigPath] = useState(initial?.config_path ?? "");
  const [envRows, setEnvRows] = useState<EnvRow[]>(
    () => initial?.env_keys.map((key) => createEnvRow(key, "", true)) ?? [],
  );
  const [unsetRows, setUnsetRows] = useState<string[]>(initial?.env_unset ?? []);
  const [validatedDraft, setValidatedDraft] = useState<string | null>(null);
  const draft = useMemo(
    () => buildDraft(initial, name, configPath, envRows, unsetRows),
    [configPath, envRows, initial, name, unsetRows],
  );
  const localError = editorError(name, envRows, unsetRows, t);
  const canSubmit = !localError && !save.isPending && !validate.isPending;

  const runValidation = (): void => {
    if (localError) return;
    validate.mutate(draft, {
      onSuccess: (result) => {
        setValidatedDraft(JSON.stringify(draft));
        notifyValidationResult(result.valid);
      },
      onError: (error) =>
        toast.error(
          apiErrorMessage(
            error,
            translateUi(
              "settings.providers.codexProfileEditor.validateError",
              "Could not validate the profile",
            ),
          ),
        ),
    });
  };
  const submit = (): void => {
    if (!canSubmit) return;
    save.mutate(draft, {
      onSuccess: () => {
        toast.success(
          translateUi("settings.providers.codexProfileEditor.saved", "Profile “{{name}}” saved", {
            name: name.trim(),
          }),
        );
        onClose();
      },
      onError: (error) =>
        toast.error(
          apiErrorMessage(
            error,
            translateUi(
              "settings.providers.codexProfileEditor.saveError",
              "Failed to save the Codex profile",
            ),
          ),
        ),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex flex-col overflow-hidden sm:max-w-xl">
        <EditorHeader name={initial?.name} />
        <EditorFields
          initial={initial}
          name={name}
          setName={setName}
          configPath={configPath}
          setConfigPath={setConfigPath}
          envRows={envRows}
          setEnvRows={setEnvRows}
          unsetRows={unsetRows}
          setUnsetRows={setUnsetRows}
          localError={localError}
          validation={validatedDraft === JSON.stringify(draft) ? validate.data : undefined}
        />
        <EditorFooter
          canSubmit={canSubmit}
          isValidating={validate.isPending}
          isSaving={save.isPending}
          onClose={onClose}
          onValidate={runValidation}
          onSave={submit}
        />
      </DialogContent>
    </Dialog>
  );
}

function buildDraft(
  initial: CodexProfileSummary | undefined,
  name: string,
  configPath: string,
  envRows: EnvRow[],
  unsetRows: string[],
): CodexProfileDraft {
  const changed = envRows.filter((row) => row.key.trim() && !row.preserved);
  return {
    id: initial?.id,
    name: name.trim(),
    config_path: configPath.trim() || null,
    env: Object.fromEntries(changed.map((row) => [row.key.trim(), row.value])),
    preserve_env_keys: envRows.filter((row) => row.preserved).map((row) => row.key),
    env_unset: unsetRows.map((key) => key.trim()).filter(Boolean),
  };
}

function duplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .find((value) => seen.has(value) || !seen.add(value));
}

function editorError(
  name: string,
  envRows: EnvRow[],
  unsetRows: string[],
  t: UiTranslator,
): string | null {
  if (!name.trim())
    return t("settings.providers.codexProfileEditor.nameRequired", "Name is required.");
  const duplicateEnv = duplicate(envRows.map((row) => row.key));
  if (duplicateEnv)
    return t(
      "settings.providers.codexProfileEditor.duplicateEnv",
      "Duplicate environment key: {{name}}",
      { name: duplicateEnv },
    );
  const duplicateUnset = duplicate(unsetRows);
  if (duplicateUnset)
    return t(
      "settings.providers.codexProfileEditor.duplicateUnset",
      "Duplicate removed key: {{name}}",
      { name: duplicateUnset },
    );
  const overlap = envRows.find((row) => unsetRows.includes(row.key.trim()))?.key;
  return overlap
    ? t(
        "settings.providers.codexProfileEditor.overlap",
        "{{name}} cannot be both set and removed.",
        { name: overlap },
      )
    : null;
}

function notifyValidationResult(valid: boolean): void {
  if (valid)
    toast.success(
      translateUi(
        "settings.providers.codexProfileEditor.validationPassed",
        "Local validation passed",
      ),
    );
  else
    toast.error(
      translateUi(
        "settings.providers.codexProfileEditor.validationFailed",
        "Profile validation failed",
      ),
    );
}

import { useMemo, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  useSaveCodexProfile,
  useValidateCodexProfile,
  type CodexProfileDraft,
  type CodexProfileSummary,
} from "@/api/codexProfiles";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiErrorMessage } from "@/lib/api-errors";

interface EnvRow {
  id: number;
  key: string;
  value: string;
  preserved: boolean;
}
let nextEnvRowId = 0;
function createEnvRow(key = "", value = "", preserved = false): EnvRow {
  return { id: nextEnvRowId++, key, value, preserved };
}

export function CodexProfileEditor({
  initial,
  onClose,
}: {
  initial?: CodexProfileSummary;
  onClose: () => void;
}): React.JSX.Element {
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
  const localError = editorError(name, envRows, unsetRows);
  const canSubmit = !localError && !save.isPending && !validate.isPending;

  const runValidation = (): void => {
    if (localError) return;
    validate.mutate(draft, {
      onSuccess: (result) => {
        setValidatedDraft(JSON.stringify(draft));
        if (result.valid) toast.success("Local validation passed");
        else toast.error("Profile validation failed");
      },
      onError: (error) => toast.error(apiErrorMessage(error, "Could not validate the profile")),
    });
  };
  const submit = (): void => {
    if (!canSubmit) return;
    save.mutate(draft, {
      onSuccess: () => {
        toast.success(`Profile “${name.trim()}” saved`);
        onClose();
      },
      onError: (error) => toast.error(apiErrorMessage(error, "Failed to save the Codex profile")),
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
        <DialogHeader className="shrink-0">
          <DialogTitle
            className="truncate"
            title={initial ? `Edit profile “${initial.name}”` : undefined}
          >
            {initial ? `Edit profile “${initial.name}”` : "New profile"}
          </DialogTitle>
          <DialogDescription>
            Values are stored in Cadencr’s local settings, not an encrypted vault. Profile list and
            edit responses mask them. Leave an existing value blank to preserve it; remove its row
            to delete it.
          </DialogDescription>
        </DialogHeader>
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
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={!canSubmit}
            onClick={runValidation}
            title="Checks local paths, environment keys, and TOML syntax; it does not prove Codex compatibility."
          >
            {validate.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}Validate
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}Save profile
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditorFields({
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
  validation: import("@/api/codexProfiles").CodexProfileValidation | undefined;
}): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-2 pr-1">
      <Field label="Name" htmlFor="codex-profile-label">
        <Input
          id="codex-profile-label"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Work account"
        />
      </Field>
      <Field label="Source config.toml (optional)" htmlFor="codex-profile-config">
        <Input
          id="codex-profile-config"
          className="font-mono text-xs"
          value={configPath}
          onChange={(event) => setConfigPath(event.target.value)}
          placeholder="/Users/me/.codex/config.toml"
        />
        <p className="text-xs text-muted-foreground">
          Leave blank to use your usual Codex home and configuration. To use a custom file, enter an
          absolute path ending literally in <code>config.toml</code>; its parent becomes the
          isolated <code>CODEX_HOME</code>. A custom home has separate authentication, history, and
          state, so you may need to sign in again. Cadencr never edits the source file.
        </p>
      </Field>
      <KeyValueRows rows={envRows} setRows={setEnvRows} />
      <StringRows
        label="Remove inherited environment variables"
        rows={unsetRows}
        setRows={setUnsetRows}
        placeholder="OPENAI_API_KEY"
      />
      {initial?.effective_home && (
        <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
          Effective CODEX_HOME: {initial.effective_home}
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
          Validated CODEX_HOME: {validation.effective_home}
        </p>
      )}
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
  return (
    <Field label="Environment variables">
      {rows.map((row, index) => (
        <div key={row.id} className="flex gap-2">
          <Input
            className="font-mono text-xs"
            value={row.key}
            placeholder="OPENAI_BASE_URL"
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
            placeholder={row.preserved ? "Stored value (leave blank to preserve)" : "Value"}
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
            aria-label="Remove environment value"
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
        <Plus className="size-3.5" /> Add row
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
            aria-label="Remove unset variable"
            onClick={() => setRows((all) => all.filter((_, i) => i !== index))}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => setRows((all) => [...all, ""])}>
        <Plus className="size-3.5" /> Add variable
      </Button>
    </Field>
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

function editorError(name: string, envRows: EnvRow[], unsetRows: string[]): string | null {
  if (!name.trim()) return "Name is required.";
  const duplicateEnv = duplicate(envRows.map((row) => row.key));
  if (duplicateEnv) return `Duplicate environment key: ${duplicateEnv}`;
  const duplicateUnset = duplicate(unsetRows);
  if (duplicateUnset) return `Duplicate removed key: ${duplicateUnset}`;
  const overlap = envRows.find((row) => unsetRows.includes(row.key.trim()))?.key;
  return overlap ? `${overlap} cannot be both set and removed.` : null;
}

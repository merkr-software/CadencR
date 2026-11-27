import { useState, type Dispatch, type ReactElement, type SetStateAction } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { translateUi, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DEFAULT_CLAUDE_PROFILE_NAME,
  useUpsertClaudeCodeProfile,
  type ClaudeCodeProfile,
} from "@/api/agentRuntime";
import { toastCallbacks } from "./SettingsStateRows";

interface EnvRow {
  key: string;
  value: string;
}

interface EnvRowsEditorProps {
  rows: EnvRow[];
  duplicateKey: string | undefined;
  setRows: Dispatch<SetStateAction<EnvRow[]>>;
}

function EnvRowsEditor({ rows, duplicateKey, setRows }: EnvRowsEditorProps): ReactElement {
  const { t } = useUiTranslation();
  const updateRow = (index: number, patch: Partial<EnvRow>): void => {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );
  };
  const removeRow = (index: number): void => {
    setRows((current) => {
      const next = current.filter((_, rowIndex) => rowIndex !== index);
      return next.length > 0 ? next : [{ key: "", value: "" }];
    });
  };
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">
        {t("settings.providers.profilesSection.environmentVariables", "Environment variables")}
      </label>
      <div className="space-y-1.5">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              className="flex-1 font-mono text-xs"
              placeholder={"ANTHROPIC_BASE_URL"}
              value={row.key}
              onChange={(event) => updateRow(index, { key: event.target.value })}
            />
            <Input
              className="flex-1 font-mono text-xs"
              placeholder={t("settings.providers.profilesSection.value", "value")}
              value={row.value}
              onChange={(event) => updateRow(index, { value: event.target.value })}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("settings.providers.profilesSection.removeRow", "Remove row")}
              onClick={() => removeRow(index)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      {duplicateKey && (
        <p className="text-xs text-destructive">
          {t("settings.providers.profilesSection.duplicateKey", "Duplicate key: {{key}}", {
            key: duplicateKey,
          })}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setRows((current) => [...current, { key: "", value: "" }])}
      >
        <Plus className="size-3.5" /> {t("settings.providers.profilesSection.addRow", "Add row")}
      </Button>
    </div>
  );
}

export function ClaudeProfileEditor({
  initial,
  existingNames,
  onClose,
}: {
  initial?: ClaudeCodeProfile;
  existingNames: string[];
  onClose: () => void;
}) {
  const { t } = useUiTranslation();
  const upsert = useUpsertClaudeCodeProfile();
  const [name, setName] = useState(initial?.name ?? "");
  const [rows, setRows] = useState<EnvRow[]>(() => {
    if (!initial) return [{ key: "", value: "" }];
    const entries = Object.entries(initial.env);
    return entries.length > 0
      ? entries.map(([key, value]) => ({ key, value }))
      : [{ key: "", value: "" }];
  });

  const isEdit = !!initial;
  const trimmedName = name.trim();
  const nameError = profileNameError(trimmedName, existingNames, isEdit, t);
  const duplicateKey = findDuplicateEnvKey(rows);

  const canSave = !nameError && !duplicateKey && !upsert.isPending;

  const handleSave = () => {
    if (!canSave) return;
    const env: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      env[key] = row.value;
    }
    upsert.mutate(
      { name: trimmedName, env },
      toastCallbacks(
        () =>
          translateUi("settings.providers.profilesSection.saved", 'Profile "{{name}}" saved', {
            name: trimmedName,
          }),
        () => translateUi("settings.providers.profilesSection.saveError", "Failed to save profile"),
        onClose,
      ),
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("settings.providers.profilesSection.editTitle", 'Edit profile "{{name}}"', {
                  name: initial!.name,
                })
              : t("settings.providers.profilesSection.newTitle", "New profile")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "settings.providers.profilesSection.envVarsAreInjectedOnTopOf",
              "Env vars are injected on top of the inherited environment when Claude is spawned.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t("settings.providers.profilesSection.name", "Name")}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={"bedrock"}
              disabled={isEdit}
              aria-invalid={!!nameError}
            />
            {nameError && <p className="text-xs text-destructive">{nameError}</p>}
          </div>
          <EnvRowsEditor rows={rows} duplicateKey={duplicateKey} setRows={setRows} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("settings.providers.profilesSection.cancel", "Cancel")}
          </Button>
          <Button disabled={!canSave} onClick={handleSave}>
            {upsert.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t("settings.providers.profilesSection.saveButton", "Save profile")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function profileNameError(
  trimmedName: string,
  existingNames: string[],
  isEdit: boolean,
  t: UiTranslator,
): string | null {
  if (!trimmedName) return t("settings.providers.profilesSection.nameRequired", "Name is required");
  if (trimmedName.toLowerCase() === DEFAULT_CLAUDE_PROFILE_NAME)
    return t("settings.providers.profilesSection.reservedName", "'{{name}}' is reserved", {
      name: DEFAULT_CLAUDE_PROFILE_NAME,
    });
  if (!isEdit && existingNames.includes(trimmedName))
    return t(
      "settings.providers.profilesSection.nameTaken",
      "A profile with this name already exists",
    );
  return null;
}

function findDuplicateEnvKey(rows: EnvRow[]): string | undefined {
  const seenKeys = new Set<string>();
  return rows.find((r) => {
    const k = r.key.trim();
    if (!k) return false;
    if (seenKeys.has(k)) return true;
    seenKeys.add(k);
    return false;
  })?.key;
}

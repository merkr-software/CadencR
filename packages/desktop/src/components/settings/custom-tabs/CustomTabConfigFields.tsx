import { useUiTranslation } from "@/lib/i18n/ui";
import { useId, useMemo } from "react";
import { useKeptDraft } from "./kept-drafts";
import { AlertCircle, Loader2 } from "lucide-react";
import type { TabConfigField } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  defaultHint,
  draftPayload,
  initialDraft,
  withDeclaredFields,
  type DraftValue,
  type SecretDraft,
} from "./config-draft";
import { SuppressingSelect } from "./SuppressingSelect";

/**
 * One scope's settings (global, or one project's) as a form with its own Save.
 * Mount it with a `key` that changes with the stored values, so a save or a
 * reload starts the draft over from what is now stored. Fields the tab declares
 * while the form is open show up from what is stored, without dropping the
 * draft of the others.
 */
export function CustomTabConfigFields({
  fields,
  stored,
  saving,
  error,
  onSave,
  draftSlot,
}: {
  fields: TabConfigField[];
  stored: Record<string, unknown>;
  saving: boolean;
  /** The service's verdict on the last save (`PLUGIN_TAB_CONFIG_INVALID`). */
  error: string | null;
  /** Resolves `true` once the values are saved and reloaded; the form then starts over. */
  onSave: (values: Record<string, unknown>) => Promise<boolean>;
  /** Where the unsaved draft is kept when the form unmounts (`useKeptDraft`). */
  draftSlot?: { id: string; version: string };
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const initial = useMemo(() => initialDraft(fields, stored), [fields, stored]);
  const [edits, setEdits, resetEdits] = useKeptDraft(draftSlot);
  const draft = useMemo(() => withDeclaredFields(edits, initial), [edits, initial]);
  const payload = useMemo(
    () => draftPayload(fields, draft, initial, t),
    [draft, fields, initial, t],
  );
  const dirty = Object.keys(payload.values).length > 0;
  const invalid = Object.keys(payload.errors).length > 0;
  const set = (key: string, value: DraftValue): void =>
    setEdits((previous) => ({ ...previous, [key]: value }));

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty || invalid || saving) return;
        void onSave(payload.values).then((saved) => {
          if (saved) resetEdits();
        });
      }}
    >
      {fields.map((field) => (
        <ConfigField
          key={field.key}
          field={field}
          value={draft[field.key]}
          error={payload.errors[field.key]}
          disabled={saving}
          onChange={(value) => set(field.key, value)}
        />
      ))}
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-[var(--acc-red)]">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!dirty || saving}
          onClick={resetEdits}
        >
          {t("customTabs.customTabConfigFields.discard", "Discard")}
        </Button>
        <Button type="submit" size="sm" disabled={!dirty || invalid || saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("common.save", "Save")}
        </Button>
      </div>
    </form>
  );
}

function ConfigField({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: TabConfigField;
  value: DraftValue | undefined;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}): React.JSX.Element | null {
  const { t } = useUiTranslation();
  const id = useId();
  if (value === undefined) return null;
  const hint = error ?? defaultHint(field, t);
  const label = (
    <label htmlFor={id} className="text-xs font-medium">
      {field.label}
    </label>
  );
  if (typeof value === "boolean") {
    return (
      <div className="flex items-center justify-between gap-6">
        {label}
        <Switch id={id} checked={value} disabled={disabled} onCheckedChange={onChange} />
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {label}
      {typeof value === "object" ? (
        <SecretControl
          id={id}
          label={field.label}
          draft={value}
          disabled={disabled}
          onChange={onChange}
        />
      ) : field.type === "select" ? (
        <SuppressingSelect
          id={id}
          value={value}
          options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
          placeholder={t("customTabs.customTabConfigFields.choose", "Choose…")}
          disabled={disabled}
          onValueChange={onChange}
        />
      ) : (
        <Input
          id={id}
          type={field.type === "number" ? "number" : "text"}
          inputMode={field.type === "number" ? "decimal" : undefined}
          value={value}
          disabled={disabled}
          aria-invalid={error !== undefined}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 text-sm"
        />
      )}
      {hint ? (
        <p
          className={
            error ? "text-[11px] text-[var(--acc-red)]" : "text-[11px] text-muted-foreground"
          }
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface SecretControlProps {
  id: string;
  label: string;
  draft: SecretDraft;
  disabled: boolean;
  onChange: (value: SecretDraft) => void;
}

/** A secret is never shown: it is Set (Replace, Clear) or a fresh password field. */
function SecretControl(props: SecretControlProps): React.JSX.Element {
  const { id, label, draft, disabled, onChange } = props;
  const { t } = useUiTranslation();
  if (draft.mode === "replace") return <ReplaceSecret {...props} />;
  const clearing = draft.mode === "clear";
  return (
    <div className="flex items-center gap-2">
      <span
        id={id}
        className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
      >
        {clearing
          ? t("customTabs.customTabConfigFields.clearedOnSave", "Cleared on save")
          : t("customTabs.customTabConfigFields.set", "Set")}
      </span>
      <div className="ml-auto flex gap-1">
        {clearing ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={disabled}
            aria-label={t(
              "customTabs.customTabConfigFields.undoClearingLabel",
              "Undo clearing {{label}}",
              { label },
            )}
            onClick={() => onChange({ ...draft, mode: "keep" })}
          >
            {t("customTabs.customTabConfigFields.undo", "Undo")}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled}
              aria-label={t("customTabs.customTabConfigFields.replaceLabel", "Replace {{label}}", {
                label,
              })}
              onClick={() => onChange({ ...draft, mode: "replace" })}
            >
              {t("customTabs.customTabConfigFields.replace", "Replace")}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled}
              aria-label={t("customTabs.customTabConfigFields.clearLabel", "Clear {{label}}", {
                label,
              })}
              onClick={() => onChange({ ...draft, mode: "clear" })}
            >
              {t("customTabs.customTabConfigFields.clear", "Clear")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function ReplaceSecret({ id, draft, disabled, onChange }: SecretControlProps): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div className="flex gap-2">
      <Input
        id={id}
        type="password"
        autoComplete="off"
        value={draft.value}
        placeholder={
          draft.isSet
            ? t("customTabs.customTabConfigFields.newValue", "New value")
            : t("customTabs.customTabConfigFields.notSet", "Not set")
        }
        disabled={disabled}
        autoFocus={draft.isSet}
        onChange={(event) => onChange({ ...draft, value: event.target.value })}
        className="h-8 text-sm"
      />
      {draft.isSet ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => onChange({ ...draft, mode: "keep", value: "" })}
        >
          {t("common.cancel", "Cancel")}
        </Button>
      ) : null}
    </div>
  );
}

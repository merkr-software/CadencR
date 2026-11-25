import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useRef, useState } from "react";
import { json } from "@codemirror/lang-json";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import BaseCodeMirrorEditor from "@/components/editor/BaseCodeMirrorEditor";
import { SettingsJsonDialogShell } from "./SettingsJsonDialogShell";
import type { SettingWarning } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";

interface SettingsJsonEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Noun used in the save toasts / error copy. Defaults to "Settings". */
  entityLabel?: string;
  path?: string;
  /** Current document text, seeded into the editor on open. */
  initialContent: string;
  isSaving: boolean;
  /** Persist `content`; resolves with non-blocking warnings, throws on error. */
  onSave: (content: string) => Promise<SettingWarning[]>;
  /** Invalidate the relevant settings queries after a successful save. */
  onSaved: () => void;
}

/**
 * Standalone JSON editor (our CodeMirror, no file tree) for a settings file.
 * Lazy-loaded so CodeMirror isn't pulled into the settings route until used.
 */
export default function SettingsJsonEditorDialog({
  open,
  onOpenChange,
  title,
  entityLabel,
  path,
  initialContent,
  isSaving,
  onSave,
  onSaved,
}: SettingsJsonEditorDialogProps): React.JSX.Element {
  const { t } = useUiTranslation();
  // The editor owns its buffer; `initialContent` only seeds it on mount (this
  // component is mounted fresh each time the dialog opens).
  const contentRef = useRef(initialContent);
  const [error, setError] = useState<string | null>(null);
  const jsonLanguage = useRef(json());

  async function handleSave(): Promise<void> {
    setError(null);
    try {
      const warnings = await onSave(contentRef.current);
      onSaved();
      onOpenChange(false);
      if (warnings.length > 0) {
        toast.warning(
          entityLabel
            ? translateUi(
                "settings.general.json.entitySavedWithWarnings",
                "{{entityLabel}} saved with {{count}} warning",
                {
                  entityLabel,
                  count: warnings.length,
                  defaultValue_other: "{{entityLabel}} saved with {{count}} warnings",
                },
              )
            : translateUi(
                "settings.general.json.savedWithWarnings",
                "Settings saved with {{count}} warning",
                {
                  count: warnings.length,
                  defaultValue_other: "Settings saved with {{count}} warnings",
                },
              ),
        );
      } else {
        toast.success(
          entityLabel
            ? translateUi("settings.general.json.entitySaved", "{{entityLabel}} saved", {
                entityLabel,
              })
            : translateUi("settings.general.json.saved", "Settings saved"),
        );
      }
    } catch (e) {
      const message = apiErrorMessage(
        e,
        entityLabel
          ? translateUi("settings.general.json.entitySaveError", "Failed to save {{entityLabel}}", {
              entityLabel: entityLabel.toLowerCase(),
            })
          : translateUi("settings.general.json.saveError", "Failed to save settings"),
      );
      setError(message);
      toast.error(message);
    }
  }

  return (
    <SettingsJsonDialogShell open={open} onOpenChange={onOpenChange} title={title} path={path}>
      <div className="min-h-0 flex-1 overflow-hidden border-b border-border">
        <BaseCodeMirrorEditor
          initialContent={initialContent}
          language={jsonLanguage.current}
          onChange={(value) => {
            contentRef.current = value;
          }}
          onSave={() => void handleSave()}
          className="h-full overflow-auto text-sm"
        />
      </div>

      {error ? (
        <div className="flex items-start gap-1.5 border-b border-border bg-[color-mix(in_oklab,var(--acc-red)_8%,var(--card))] px-6 py-2 text-xs text-[var(--acc-red)]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </div>
      ) : null}

      <DialogFooter className="px-6 py-3">
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
          {t("common.cancel", "Cancel")}
        </Button>
        <Button size="sm" disabled={isSaving} onClick={() => void handleSave()}>
          {isSaving ? t("common.saving", "Saving…") : t("common.save", "Save")}
        </Button>
      </DialogFooter>
    </SettingsJsonDialogShell>
  );
}

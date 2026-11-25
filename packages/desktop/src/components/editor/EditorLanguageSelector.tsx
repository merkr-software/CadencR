import { useUiTranslation, translateUi, UiTrans } from "@/lib/i18n/ui";
import { memo, useEffect, useId, useState, type Dispatch, type SetStateAction } from "react";
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import { useShortcut } from "@/hooks/useShortcut";
import { apiErrorMessage } from "@/lib/api-errors";
import { getFileName } from "@/lib/file-language";
import { getEditorLanguageLabel, type EditorLanguageId } from "@/lib/editor-language";
import type { EditorLanguagePreference } from "@/lib/editor-language-overrides";
import type { EditorLanguageState } from "@/hooks/useEditorLanguage";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ResolvedShortcutHint } from "@/components/KbdShortcut";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { EditorLanguageCombobox } from "./EditorLanguageCombobox";

export interface EditorLanguageSelectorProps {
  filePath: string;
  language: EditorLanguageState;
}

export const EditorLanguageSelector = memo(function EditorLanguageSelector(
  props: EditorLanguageSelectorProps,
) {
  const { t } = useUiTranslation();
  const { language } = props;
  const [open, setOpen] = useState(false);
  const [preference, setPreference] = useState<EditorLanguagePreference>(language.preference);
  const [applyToExtension, setApplyToExtension] = useState(language.applyToExtension);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const checkboxId = useId();
  const selectId = useId();
  const label = getEditorLanguageLabel(language.languageId, t);

  useEffect(() => {
    if (!open) return;
    setPreference(language.preference);
    setApplyToExtension(language.applyToExtension);
    setActionError(null);
  }, [language.applyToExtension, language.preference, open]);

  async function handleApply(): Promise<void> {
    setActionError(null);
    try {
      await language.save({ preference, applyToExtension });
      setOpen(false);
    } catch (error) {
      setActionError(
        apiErrorMessage(
          error,
          translateUi(
            "workspace.editor.languageMode.saveFailed",
            "Could not save language override",
          ),
        ),
      );
    }
  }

  async function handleRetry(): Promise<void> {
    setActionError(null);
    setIsRetrying(true);
    try {
      await language.retry();
    } catch (error) {
      setActionError(
        apiErrorMessage(
          error,
          translateUi(
            "workspace.editor.languageMode.reloadFailed",
            "Could not reload language overrides",
          ),
        ),
      );
    } finally {
      setIsRetrying(false);
    }
  }

  useLanguageSelectorShortcuts(open, language, handleApply, setApplyToExtension);

  return (
    <Dialog open={open} onOpenChange={(next) => !language.isSaving && setOpen(next)}>
      <LanguageSelectorTrigger
        label={label}
        isLoading={language.isLoading}
        hasError={language.loadError !== null}
      />
      <DialogContent className="sm:max-w-md" showCloseButton={!language.isSaving}>
        <LanguageDialogHeader filePath={props.filePath} />
        <div className="space-y-4">
          <LanguageFields
            selectId={selectId}
            checkboxId={checkboxId}
            preference={preference}
            detectedLanguageId={language.detectedLanguageId}
            inheritedLanguageId={language.inheritedLanguageId}
            extension={language.extension}
            applyToExtension={applyToExtension}
            disabled={language.isSaving}
            onPreferenceChange={setPreference}
            onApplyToExtensionChange={setApplyToExtension}
          />
          <LanguageAlert
            message={actionError ?? language.loadError}
            canSave={language.canSave}
            isRetrying={isRetrying}
            onRetry={handleRetry}
          />
        </div>

        <LanguageDialogFooter
          canSave={language.canSave}
          isSaving={language.isSaving}
          onCancel={() => setOpen(false)}
          onApply={() => void handleApply()}
        />
      </DialogContent>
    </Dialog>
  );
});

function LanguageDialogFooter({
  canSave,
  isSaving,
  onCancel,
  onApply,
}: {
  canSave: boolean;
  isSaving: boolean;
  onCancel: () => void;
  onApply: () => void;
}) {
  const { t } = useUiTranslation();
  return (
    <DialogFooter>
      <Button type="button" variant="outline" disabled={isSaving} onClick={onCancel}>
        {t("workspace.editor.languageMode.cancel", "Cancel")}
      </Button>
      <Button type="button" disabled={!canSave || isSaving} onClick={onApply}>
        {isSaving && <Loader2Icon className="size-4 animate-spin" />}
        <span>
          {isSaving
            ? t("workspace.editor.languageMode.applying", "Applying…")
            : t("workspace.editor.languageMode.apply", "Apply")}
        </span>
        {!isSaving && <ResolvedShortcutHint shortcutId="editor-language-confirm" />}
      </Button>
    </DialogFooter>
  );
}

function useLanguageSelectorShortcuts(
  open: boolean,
  language: EditorLanguageState,
  onApply: () => Promise<void>,
  setApplyToExtension: Dispatch<SetStateAction<boolean>>,
): void {
  useShortcut("editor-language-confirm", () => void onApply(), {
    enabled: open && language.canSave && !language.isSaving,
    preventDefault: true,
    stopPropagation: true,
  });
  useShortcut(
    "editor-language-toggle-extension",
    () => setApplyToExtension((current) => !current),
    {
      enabled: open && language.extension !== null && !language.isSaving,
      enableOnContentEditable: false,
      enableOnFormTags: false,
      preventDefault: true,
      stopPropagation: true,
    },
  );
}

function LanguageSelectorTrigger({
  label,
  isLoading,
  hasError,
}: {
  label: string;
  isLoading: boolean;
  hasError: boolean;
}) {
  const { t } = useUiTranslation();
  return (
    <DialogTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={isLoading}
        className="h-auto px-1 py-0 font-normal text-muted-foreground"
        aria-label={t("workspace.editor.languageMode.languageMode", "Language mode: {{language}}", {
          language: label,
        })}
      >
        {isLoading && <Loader2Icon className="size-3 animate-spin" />}
        {hasError && !isLoading && <AlertCircleIcon className="size-3 text-destructive" />}
        {label}
      </Button>
    </DialogTrigger>
  );
}

interface LanguageFieldsProps {
  selectId: string;
  checkboxId: string;
  preference: EditorLanguagePreference;
  detectedLanguageId: EditorLanguageId;
  inheritedLanguageId: EditorLanguageId;
  extension: string | null;
  applyToExtension: boolean;
  disabled: boolean;
  onPreferenceChange: (preference: EditorLanguagePreference) => void;
  onApplyToExtensionChange: (apply: boolean) => void;
}

function LanguageFields(props: LanguageFieldsProps) {
  const { t } = useUiTranslation();
  return (
    <>
      <div className="space-y-2">
        <label htmlFor={props.selectId} className="text-sm font-medium">
          {t("workspace.editor.languageMode.language", "Language")}
        </label>
        <EditorLanguageCombobox
          id={props.selectId}
          preference={props.preference}
          automaticLanguageId={
            props.applyToExtension ? props.detectedLanguageId : props.inheritedLanguageId
          }
          disabled={props.disabled}
          onChange={props.onPreferenceChange}
        />
      </div>
      {props.extension && (
        <div className="flex items-start gap-2 rounded-md border border-border p-3">
          <Checkbox
            id={props.checkboxId}
            checked={props.applyToExtension}
            onCheckedChange={(checked) => props.onApplyToExtensionChange(checked === true)}
            disabled={props.disabled}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={props.checkboxId} className="cursor-pointer text-sm font-medium">
                {t(
                  "workspace.editor.languageMode.matchingFiles",
                  "Apply to all *.{{extension}} files",
                  { extension: props.extension },
                )}
              </label>
              <ResolvedShortcutHint shortcutId="editor-language-toggle-extension" />
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                "workspace.editor.languageMode.useThisLanguageForMatchingFilesIn",
                "Use this language for matching files in this project, including files opened later.",
              )}
            </p>
          </div>
        </div>
      )}
    </>
  );
}

function LanguageAlert({
  message,
  canSave,
  isRetrying,
  onRetry,
}: {
  message: string | null;
  canSave: boolean;
  isRetrying: boolean;
  onRetry: () => Promise<void>;
}) {
  const { t } = useUiTranslation();
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
    >
      {message}
      {!canSave && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 flex"
          disabled={isRetrying}
          onClick={() => void onRetry()}
        >
          {isRetrying && <Loader2Icon className="size-3.5 animate-spin" />}
          {t("workspace.editor.languageMode.retry", "Retry")}
        </Button>
      )}
    </div>
  );
}

function LanguageDialogHeader({ filePath }: { filePath: string }) {
  const { t } = useUiTranslation();
  return (
    <DialogHeader>
      <DialogTitle>
        {t("workspace.editor.languageMode.selectLanguageMode", "Select Language Mode")}
      </DialogTitle>
      <DialogDescription>
        <UiTrans
          i18nKey="workspace.editor.languageMode.description"
          defaults="Choose the syntax and language tooling used for <file>{{name}}</file>."
          values={{ name: getFileName(filePath) }}
          components={{ file: <code /> }}
        />
      </DialogDescription>
    </DialogHeader>
  );
}

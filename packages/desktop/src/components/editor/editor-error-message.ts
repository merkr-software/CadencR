import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
import { apiErrorMessage } from "@/lib/api-errors";

export class EditorOperationError extends Error {
  constructor(
    message: string,
    readonly localize: (t: UiTranslator) => string,
  ) {
    super(message);
  }
}

export function editorErrorMessage(
  error: unknown,
  fallback: string,
  t: UiTranslator = translateUi,
): string {
  return error instanceof EditorOperationError
    ? error.localize(t)
    : apiErrorMessage(error, fallback);
}

export function editorSyncFailed(t: UiTranslator): string {
  return t("workspace.editor.save.syncFailed", "Failed to synchronize file");
}

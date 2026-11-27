import { translateUi } from "@/lib/i18n/ui";
import { toast } from "sonner";
import { apiErrorMessage, stripElectronIpcPrefix } from "@/lib/api-errors";

export function formatBrowserIpcError(error: unknown): string {
  const raw = apiErrorMessage(error, String(error)).trim();
  const stripped = stripElectronIpcPrefix(raw);
  return stripped.length > 0
    ? stripped
    : raw || translateUi("workspace.tools.browserErrors.unknown", "Unknown error");
}

export function showBrowserError(error: unknown, title: string): void {
  const message = formatBrowserIpcError(error);
  toast.error(title, { description: message });
}

export function reportBrowserError(error: unknown): void {
  showBrowserError(
    error,
    translateUi("workspace.tools.browserErrors.browserActionFailed", "Browser action failed"),
  );
}

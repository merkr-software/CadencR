import { translateUi } from "@/lib/i18n/ui";
import { toast } from "sonner";

/**
 * Write `text` to the system clipboard and surface a sonner toast on success
 * (with `successLabel`) or failure. Centralizes the try/catch + toast pattern
 * shared by every "copy X" context-menu item and `CopyButton`.
 *
 * For markdown-format conversions (plain/slack/markdown), use `copyAs` from
 * `lib/markdown-export.ts` instead.
 */
export async function copyToClipboard(text: string, successLabel: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(successLabel);
  } catch {
    toast.error(translateUi("common.copyFailed", "Failed to copy"));
  }
}

import { translateUi } from "@/lib/i18n/ui";
import { isUntitledPath } from "@/stores/editor-store";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "sonner";

/**
 * Copy an editor file's project-relative path to the clipboard, surfacing a
 * "Path copied" toast on success. Shared by the tab context-menu item and the
 * ⌘⇧C shortcut so both behave identically. Untitled/unsaved buffers and the
 * no-active-file case have no real path, so they show an error toast instead
 * of copying a meaningless `untitled://…` sentinel.
 */
export function copyFilePath(filePath: string | null | undefined): void {
  if (!filePath || isUntitledPath(filePath)) {
    toast.error(translateUi("workspace.editor.copyFilePath.missingPath", "No file path to copy"));
    return;
  }
  void copyToClipboard(
    filePath,
    translateUi("workspace.editor.copyFilePath.copied", "Path copied"),
  );
}

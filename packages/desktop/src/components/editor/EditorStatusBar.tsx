import { useUiTranslation } from "@/lib/i18n/ui";
/**
 * Bottom status bar for a single CodeMirror editor buffer. Renders cursor
 * position, autosave indicator, LSP status, language label, encoding, and
 * — for files that support it — a markdown preview toggle. Extracted from
 * `CodeMirrorEditor.tsx` to keep that file under the 400-line limit.
 */
import { memo, type ReactNode } from "react";
import { EyeIcon, PencilIcon } from "lucide-react";
import { EditorDiskSyncIndicator, type EditorDiskSyncState } from "./EditorDiskSyncIndicator";
import { LspStatusIndicator } from "./LspStatusIndicator";
import type { LspStatus } from "@/lib/lsp/useLsp";

interface PreviewToggle {
  active: boolean;
  onToggle: () => void;
}

export interface EditorStatusBarProps {
  line: number;
  col: number;
  language: ReactNode;
  autoSavedVisible: boolean;
  diskSync?: EditorDiskSyncState;
  isFormatting?: boolean;
  readError?: string;
  lspStatus: LspStatus;
  lspLanguageId: string | null;
  lspError?: string;
  /**
   * Force a fresh LSP connection attempt. Supplied by the editor as
   * `useLsp().onRetry`; when present the error indicator becomes clickable.
   * Kept as a prop (not an internal `client-manager` import) so this status
   * bar stays a light leaf component with no CodeMirror/LSP module pull-in.
   */
  onLspRetry?: () => void;
  /** Present only for files that support a markdown preview. */
  preview?: PreviewToggle;
}

export const EditorStatusBar = memo(function EditorStatusBar({
  line,
  col,
  language,
  autoSavedVisible,
  diskSync,
  isFormatting,
  readError,
  lspStatus,
  lspLanguageId,
  lspError,
  onLspRetry,
  preview,
}: EditorStatusBarProps) {
  const { t } = useUiTranslation();
  const isPreview = preview?.active ?? false;
  return (
    <div className="flex items-center justify-between px-3 py-0.5 border-t border-border bg-card text-xs text-muted-foreground shrink-0">
      <span>
        {isPreview
          ? t("workspace.editor.editorStatusBar.preview", "Preview")
          : t("workspace.editor.editorStatusBar.cursorPosition", "Ln {{line}}, Col {{column}}", {
              line,
              column: col,
            })}
      </span>
      <div className="flex items-center gap-3">
        {readError && (
          <span role="alert" title={readError} className="text-destructive">
            {t("workspace.editor.editorStatusBar.diskCheckFailed", "Disk check failed")}
          </span>
        )}
        {diskSync && <EditorDiskSyncIndicator sync={diskSync} />}
        {isFormatting ? (
          <span role="status">
            {t("workspace.editor.editorStatusBar.formatting", "Formatting…")}
          </span>
        ) : diskSync?.isSaving ? (
          <span role="status">{t("workspace.editor.editorStatusBar.saving", "Saving…")}</span>
        ) : (
          autoSavedVisible && (
            <span>{t("workspace.editor.editorStatusBar.autoSaved", "Auto-saved")}</span>
          )
        )}
        {preview && (
          <button
            type="button"
            onClick={preview.onToggle}
            className="inline-flex items-center gap-1 rounded px-1 text-muted-foreground hover:text-foreground hover:bg-muted"
            aria-pressed={isPreview}
          >
            {isPreview ? <PencilIcon className="size-3" /> : <EyeIcon className="size-3" />}
            {isPreview
              ? t("workspace.editor.editorStatusBar.edit", "Edit")
              : t("workspace.editor.editorStatusBar.preview", "Preview")}
          </button>
        )}
        <span className="inline-flex items-center gap-1">
          <LspStatusIndicator
            status={lspStatus}
            languageId={lspLanguageId}
            errorMessage={lspError}
            onRetry={onLspRetry}
          />
          {language}
        </span>
        <span>UTF-8</span>
      </div>
    </div>
  );
});

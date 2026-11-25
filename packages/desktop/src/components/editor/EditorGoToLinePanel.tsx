import { useUiTranslation } from "@/lib/i18n/ui";
/**
 * Go-to-line overlay panel. Mounted by `CodeMirrorEditor` while the
 * `editor-go-to-line` shortcut (⌃G / ⌘⌥G) is open. Lives next to the
 * editor surface (not inside CodeMirror) so the input is a real DOM
 * element with normal focus behaviour and so the rest of the editor —
 * including the search panel — keeps working without contention.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { EditorView } from "@codemirror/view";
import { CornerDownRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { scrollToEditorLine } from "./editor-lines";

interface EditorGoToLinePanelProps {
  view: EditorView;
  /** Bumped by the parent each time the shortcut fires so the input re-focuses. */
  reopenSignal: number;
  onClose: () => void;
}

export function EditorGoToLinePanel({ view, reopenSignal, onClose }: EditorGoToLinePanelProps) {
  const { t } = useUiTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState("");

  // Refocus + select-all whenever the parent bumps `reopenSignal` — including
  // first mount. Mirrors the EditorSearchPanel pattern so the shortcut feels
  // identical whether the panel was already visible or not.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [reopenSignal]);

  const parsed = useMemo(() => parseLineNumber(value), [value]);
  const isValid = parsed !== null;

  const handleClose = useCallback((): void => {
    setValue("");
    onClose();
    view.focus();
  }, [onClose, view]);

  const handleSubmit = useCallback((): void => {
    if (parsed === null) return;
    // Re-reads doc.lines inside the helper so we clamp against the live doc
    // length, not a value captured at panel mount.
    scrollToEditorLine(view, parsed);
    handleClose();
  }, [parsed, view, handleClose]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        handleSubmit();
      }
    },
    [handleClose, handleSubmit],
  );

  return (
    <div
      className="absolute top-2 right-3 z-20 flex items-center gap-1 rounded-md border border-border bg-card/95 px-2 py-1 shadow-md backdrop-blur"
      role="dialog"
      aria-label={t("workspace.editor.editorGoToLinePanel.goToLine", "Go to line")}
      onMouseDown={(event) => {
        if (event.target !== inputRef.current) event.preventDefault();
      }}
    >
      <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("workspace.editor.editorGoToLinePanel.lineRange", "Line 1–{{lastLine}}", {
          lastLine: view.state.doc.lines,
        })}
        className={cn(
          "w-44 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70",
          value.length > 0 && !isValid && "text-destructive",
        )}
        aria-invalid={value.length > 0 && !isValid}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        title={t("workspace.editor.editorGoToLinePanel.closeEsc", "Close (Esc)")}
        aria-label={t("workspace.editor.editorGoToLinePanel.closeGoToLine", "Close go-to-line")}
        onClick={handleClose}
      >
        <X />
      </Button>
    </div>
  );
}

/**
 * Parse the input as a positive integer line number. Returns `null` for
 * empty input or non-numeric content, so the parent can disable submit
 * without showing a destructive style on first keystroke.
 */
function parseLineNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

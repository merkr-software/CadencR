import { useUiTranslation, translateUi } from "@/lib/i18n/ui";
/**
 * Inline rename overlay. Opened by F2 while the editor is focused. Mirrors
 * `EditorGoToLinePanel`: a real DOM input rendered next to the editor surface
 * (not inside CodeMirror) so focus behaves normally.
 *
 * Probes `prepareRename` on open to seed the input with the symbol name and
 * bail out (with a toast) when the cursor isn't on a renameable symbol. On
 * submit it performs the rename and applies the `WorkspaceEdit` across every
 * affected file, showing a "Renamed in N files" summary toast.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { EditorView } from "@codemirror/view";
import { Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-errors";
import { cn } from "@/lib/utils";
import { prepareRename, performRename } from "@/lib/lsp/rename";
import type { WorkspaceEditHost } from "@/lib/lsp/workspace-edit";

interface EditorRenamePanelProps {
  view: EditorView;
  /** Bumped each time F2 fires so the input re-focuses + re-probes. */
  reopenSignal: number;
  host: WorkspaceEditHost;
  onClose: () => void;
}

function usePrepareRename({
  view,
  reopenSignal,
  handleClose,
  inputRef,
  setValue,
}: {
  view: EditorView;
  reopenSignal: number;
  handleClose: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  setValue: Dispatch<SetStateAction<string>>;
}): void {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const prep = await prepareRename(view);
        if (cancelled) return;
        if (!prep) {
          toast.info(
            translateUi(
              "workspace.editor.renameSymbol.nothingToRename",
              "Nothing to rename at the cursor.",
            ),
          );
          handleClose();
          return;
        }
        setValue(prep.placeholder);
        inputRef.current?.focus();
        inputRef.current?.select();
      } catch (error) {
        if (cancelled) return;
        toast.error(
          translateUi(
            "workspace.editor.renameSymbol.unavailable",
            "Rename unavailable: {{error}}",
            { error: apiErrorMessage(error, String(error)) },
          ),
        );
        handleClose();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handleClose, inputRef, reopenSignal, setValue, view]);
}

export function EditorRenamePanel({ view, reopenSignal, host, onClose }: EditorRenamePanelProps) {
  const { t } = useUiTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const handleClose = useCallback((): void => {
    onClose();
    view.focus();
  }, [onClose, view]);

  usePrepareRename({ view, reopenSignal, handleClose, inputRef, setValue });

  const handleSubmit = useCallback(async (): Promise<void> => {
    const next = value.trim();
    if (next === "" || busy) return;
    setBusy(true);
    try {
      const { fileCount } = await performRename(view, next, host);
      toast.success(
        translateUi("workspace.editor.renameSymbol.renamedInFiles", {
          count: fileCount,
          defaultValue_zero: "Renamed in {{count, number}} files.",
          defaultValue_one: "Renamed in {{count, number}} file.",
          defaultValue_other: "Renamed in {{count, number}} files.",
        }),
      );
      handleClose();
    } catch (err) {
      toast.error(
        translateUi("workspace.editor.renameSymbol.failed", "Rename failed: {{error}}", {
          error: apiErrorMessage(err, String(err)),
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [value, busy, view, host, handleClose]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void handleSubmit();
      }
    },
    [handleClose, handleSubmit],
  );

  return (
    <div
      className="absolute top-2 right-3 z-20 flex items-center gap-1 rounded-md border border-border bg-card/95 px-2 py-1 shadow-md backdrop-blur"
      role="dialog"
      aria-label={t("workspace.editor.renameSymbol.renameSymbol", "Rename symbol")}
      onMouseDown={(event) => {
        if (event.target !== inputRef.current) event.preventDefault();
      }}
    >
      <Pencil className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        type="text"
        spellCheck={false}
        value={value}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("workspace.editor.renameSymbol.newName", "New name")}
        className={cn(
          "w-44 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70",
          busy && "opacity-60",
        )}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        title={t("workspace.editor.renameSymbol.closeEsc", "Close (Esc)")}
        aria-label={t("workspace.editor.renameSymbol.closeRename", "Close rename")}
        onClick={handleClose}
      >
        <X />
      </Button>
    </div>
  );
}

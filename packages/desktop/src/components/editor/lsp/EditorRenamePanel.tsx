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
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { EditorView } from "@codemirror/view";
import { Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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

export function EditorRenamePanel({ view, reopenSignal, host, onClose }: EditorRenamePanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const handleClose = useCallback((): void => {
    onClose();
    view.focus();
  }, [onClose, view]);

  // Probe prepareRename on (re)open; seed the input or bail with a toast.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const prep = await prepareRename(view);
        if (cancelled) return;
        if (!prep) {
          toast.info("Nothing to rename at the cursor.");
          handleClose();
          return;
        }
        setValue(prep.placeholder);
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      } catch (err) {
        if (cancelled) return;
        toast.error(`Rename unavailable: ${err instanceof Error ? err.message : String(err)}`);
        handleClose();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, reopenSignal, handleClose]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    const next = value.trim();
    if (next === "" || busy) return;
    setBusy(true);
    try {
      const { fileCount } = await performRename(view, next, host);
      toast.success(`Renamed in ${fileCount} file${fileCount === 1 ? "" : "s"}.`);
      handleClose();
    } catch (err) {
      toast.error(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
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
      aria-label="Rename symbol"
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
        placeholder="New name"
        className={cn(
          "w-44 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70",
          busy && "opacity-60",
        )}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        title="Close (Esc)"
        aria-label="Close rename"
        onClick={handleClose}
      >
        <X />
      </Button>
    </div>
  );
}

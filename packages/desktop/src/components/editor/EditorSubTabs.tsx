import { useState } from "react";
import { X } from "lucide-react";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { FileSymbolIcon } from "./file-icons";
import { useEditorStore } from "@/stores/editor-store";
import { saveFile } from "./editorSaveRegistry";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useFileTreeMutations } from "@/hooks/useFileTreeMutations";

interface EditorSubTabsProps {
  featureId: number;
  paneId: string;
  projectId: number;
}

interface PendingClose {
  filePath: string;
  fileName: string;
}

export default function EditorSubTabs({ featureId, paneId, projectId }: EditorSubTabsProps) {
  const pane = useEditorStore((s) => s.features[featureId]?.panes[paneId]);
  const setActiveFile = useEditorStore((s) => s.setActiveFile);
  const closeTab = useEditorStore((s) => s.closeTab);
  const { reveal } = useFileTreeMutations(projectId, featureId);

  function closeMany(filter: (path: string) => boolean) {
    const targets = (pane?.tabs ?? []).filter((t) => filter(t.filePath));
    for (const t of targets) {
      closeTab(featureId, paneId, t.filePath);
    }
  }

  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const tabs = pane?.tabs ?? [];
  const activeFilePath = pane?.activeFilePath ?? null;

  function requestClose(filePath: string, fileName: string, isDirty: boolean) {
    if (isDirty) {
      setPendingClose({ filePath, fileName });
    } else {
      closeTab(featureId, paneId, filePath);
    }
  }

  function handleDiscard() {
    if (!pendingClose) return;
    closeTab(featureId, paneId, pendingClose.filePath);
    setPendingClose(null);
  }

  async function handleSaveAndClose() {
    if (!pendingClose) return;
    setIsSaving(true);
    try {
      await saveFile(paneId, pendingClose.filePath);
      closeTab(featureId, paneId, pendingClose.filePath);
      setPendingClose(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save file";
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  }

  // Next/prev tab navigation (capture-phase so it works with CodeMirror focused).
  // All three are scoped to the editor tab — Cmd+Shift+] / Cmd+Shift+[ should
  // not cycle file tabs while focused on terminal/git/agent, and Cmd+W must
  // not close a buffer while another tab is in front (it would conflict with
  // the global Cmd+W close-window shortcut otherwise).
  useScopedGlobalShortcutById(
    "editor-next-tab",
    (e) => {
      if (!tabs.length) return;
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.filePath === activeFilePath);
      const next = tabs[(idx + 1) % tabs.length];
      if (next) setActiveFile(featureId, paneId, next.filePath);
    },
    "editor",
  );

  useScopedGlobalShortcutById(
    "editor-prev-tab",
    (e) => {
      if (!tabs.length) return;
      e.preventDefault();
      const idx = tabs.findIndex((t) => t.filePath === activeFilePath);
      const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
      if (prev) setActiveFile(featureId, paneId, prev.filePath);
    },
    "editor",
  );

  // CMD+W: close active buffer. Capture phase keeps this ahead of CodeMirror,
  // and sandboxed previews bridge their own keydown back to this parent listener.
  useScopedGlobalShortcutById(
    "editor-close",
    (event) => {
      if (!activeFilePath) return;
      event.preventDefault();
      event.stopPropagation();
      const tab = tabs.find((t) => t.filePath === activeFilePath);
      if (tab) requestClose(tab.filePath, tab.fileName, tab.isDirty);
    },
    "editor",
  );

  if (!tabs.length) return null;

  return (
    <>
      <div className="flex items-center border-b border-border bg-card overflow-x-auto shrink-0 flex-nowrap">
        {tabs.map((tab) => {
          const isActive = activeFilePath === tab.filePath;
          const showClose = !tab.isDirty || hoveredClose === tab.filePath;

          return (
            <ContextMenu key={tab.filePath}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    // `border-b-2 border-b-transparent` reserves the 2px
                    // baseline so the active-tab indicator doesn't shift the
                    // row height.
                    "flex items-center gap-1.5 px-3 py-1.5 text-sm border-r border-border border-b-2 border-b-transparent whitespace-nowrap shrink-0 hover:bg-accent transition-colors",
                    isActive
                      ? "bg-background text-foreground border-b-primary"
                      : "text-muted-foreground",
                  )}
                  onClick={() => setActiveFile(featureId, paneId, tab.filePath)}
                >
                  <FileSymbolIcon fileName={tab.fileName} className="shrink-0 flex items-center" />
                  <span>{tab.disambiguatedName}</span>
                  <span
                    role="button"
                    aria-label={`Close ${tab.disambiguatedName}`}
                    tabIndex={0}
                    className="ml-0.5 rounded hover:bg-muted p-0.5 flex items-center justify-center w-4 h-4"
                    onMouseEnter={() => setHoveredClose(tab.filePath)}
                    onMouseLeave={() => setHoveredClose(null)}
                    onClick={(e) => {
                      e.stopPropagation();
                      requestClose(tab.filePath, tab.fileName, tab.isDirty);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        requestClose(tab.filePath, tab.fileName, tab.isDirty);
                      }
                    }}
                  >
                    {showClose ? (
                      <X className="w-3 h-3" />
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full bg-primary block" />
                    )}
                  </span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onSelect={() => requestClose(tab.filePath, tab.fileName, tab.isDirty)}
                >
                  Close
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => closeMany((p) => p !== tab.filePath)}>
                  Close Others
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => {
                    const idx = tabs.findIndex((t) => t.filePath === tab.filePath);
                    closeMany((p) => {
                      const otherIdx = tabs.findIndex((x) => x.filePath === p);
                      return otherIdx > idx;
                    });
                  }}
                >
                  Close to the Right
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => closeMany(() => true)}>Close All</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => void copyToClipboard(tab.filePath, "Path copied")}>
                  Copy Path
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void reveal(tab.filePath)}>
                  Reveal in File Manager
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>

      <Dialog
        open={pendingClose !== null}
        onOpenChange={(open) => {
          if (!open) setPendingClose(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes in <strong>{pendingClose?.fileName}</strong>. Discard
              changes?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingClose(null)}>
              Cancel
            </Button>
            <Button variant="outline" onClick={handleDiscard}>
              Discard
            </Button>
            <Button onClick={() => void handleSaveAndClose()} disabled={isSaving}>
              {isSaving ? "Saving…" : "Save & Close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

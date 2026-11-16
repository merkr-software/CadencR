import { useCallback, useMemo, useState } from "react";
import { ClipboardCopyIcon, EyeIcon, PanelRightCloseIcon, X } from "lucide-react";
import { useScopedGlobalShortcutById } from "@/hooks/useShortcut";
import { cn } from "@/lib/utils";
import { copyFilePath } from "./copyFilePath";
import { FileSymbolIcon } from "./file-icons";
import { useEditorStore } from "@/stores/editor-store";
import { saveFile } from "./editorSaveRegistry";
import { apiErrorMessage } from "@/lib/api-errors";
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
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ContextMenuActionItem } from "@/components/ContextMenuActionItem";
import { useFileTreeMutations } from "@/hooks/useFileTreeMutations";
import type { EditorTab } from "@/stores/editor-store-types";

interface EditorSubTabsProps {
  featureId: number;
  paneId: string;
  projectId: number;
}

interface PendingClose {
  filePath: string;
  fileName: string;
}

function useEditorSubTabShortcuts({
  activeFilePath,
  featureId,
  paneId,
  requestClose,
  setActiveFile,
  tabs,
}: {
  activeFilePath: string | null;
  featureId: number;
  paneId: string;
  requestClose: (filePath: string, fileName: string, isDirty: boolean) => void;
  setActiveFile: ReturnType<typeof useEditorStore.getState>["setActiveFile"];
  tabs: EditorTab[];
}): void {
  useScopedGlobalShortcutById(
    "editor-next-tab",
    (event) => {
      if (!tabs.length) return;
      event.preventDefault();
      const index = tabs.findIndex((tab) => tab.filePath === activeFilePath);
      const next = tabs[(index + 1) % tabs.length];
      if (next) setActiveFile(featureId, paneId, next.filePath);
    },
    "editor",
  );
  useScopedGlobalShortcutById(
    "editor-prev-tab",
    (event) => {
      if (!tabs.length) return;
      event.preventDefault();
      const index = tabs.findIndex((tab) => tab.filePath === activeFilePath);
      const previous = tabs[(index - 1 + tabs.length) % tabs.length];
      if (previous) setActiveFile(featureId, paneId, previous.filePath);
    },
    "editor",
  );
  useScopedGlobalShortcutById(
    "editor-close",
    (event) => {
      if (!activeFilePath) return;
      event.preventDefault();
      event.stopPropagation();
      const tab = tabs.find((candidate) => candidate.filePath === activeFilePath);
      if (tab) requestClose(tab.filePath, tab.fileName, tab.isDirty);
    },
    "editor",
  );
}

function useEditorSubTabsController({ featureId, paneId, projectId }: EditorSubTabsProps) {
  const pane = useEditorStore((state) => state.features[featureId]?.panes[paneId]);
  const setActiveFile = useEditorStore((state) => state.setActiveFile);
  const closeTab = useEditorStore((state) => state.closeTab);
  const { reveal } = useFileTreeMutations(projectId, featureId);
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const tabs = pane?.tabs ?? [];
  const activeFilePath = pane?.activeFilePath ?? null;
  const closeMany = useCallback(
    (filter: (path: string) => boolean): void => {
      for (const tab of tabs.filter((candidate) => filter(candidate.filePath))) {
        closeTab(featureId, paneId, tab.filePath);
      }
    },
    [closeTab, featureId, paneId, tabs],
  );
  const requestClose = useCallback(
    (filePath: string, fileName: string, isDirty: boolean): void => {
      if (isDirty) setPendingClose({ filePath, fileName });
      else closeTab(featureId, paneId, filePath);
    },
    [closeTab, featureId, paneId],
  );
  const handleDiscard = useCallback((): void => {
    if (!pendingClose) return;
    closeTab(featureId, paneId, pendingClose.filePath);
    setPendingClose(null);
  }, [closeTab, featureId, paneId, pendingClose]);
  const handleSaveAndClose = useCallback(async (): Promise<void> => {
    if (!pendingClose) return;
    setIsSaving(true);
    try {
      await saveFile(paneId, pendingClose.filePath);
      closeTab(featureId, paneId, pendingClose.filePath);
      setPendingClose(null);
    } catch (error) {
      toast.error(apiErrorMessage(error, "Failed to save file"));
    } finally {
      setIsSaving(false);
    }
  }, [closeTab, featureId, paneId, pendingClose]);
  useEditorSubTabShortcuts({
    activeFilePath,
    featureId,
    paneId,
    requestClose,
    setActiveFile,
    tabs,
  });
  return useMemo(
    () => ({
      activeFilePath,
      closeMany,
      handleDiscard,
      handleSaveAndClose,
      hoveredClose,
      isSaving,
      pendingClose,
      requestClose,
      reveal,
      setActiveFile,
      setHoveredClose,
      setPendingClose,
      tabs,
    }),
    [
      activeFilePath,
      closeMany,
      handleDiscard,
      handleSaveAndClose,
      hoveredClose,
      isSaving,
      pendingClose,
      requestClose,
      reveal,
      setActiveFile,
      tabs,
    ],
  );
}

type EditorSubTabsController = ReturnType<typeof useEditorSubTabsController>;

export default function EditorSubTabs(props: EditorSubTabsProps) {
  const controller = useEditorSubTabsController(props);
  if (!controller.tabs.length) return null;
  return (
    <>
      <div className="flex items-center border-b border-border bg-card overflow-x-auto shrink-0 flex-nowrap">
        {controller.tabs.map((tab) => (
          <EditorSubTab key={tab.filePath} tab={tab} controller={controller} {...props} />
        ))}
      </div>
      <UnsavedChangesDialog controller={controller} />
    </>
  );
}

function EditorSubTab({
  controller,
  featureId,
  paneId,
  tab,
}: Pick<EditorSubTabsProps, "featureId" | "paneId"> & {
  controller: EditorSubTabsController;
  tab: EditorTab;
}) {
  const isActive = controller.activeFilePath === tab.filePath;
  const showClose = !tab.isDirty || controller.hoveredClose === tab.filePath;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-sm border-r border-border border-b-2 border-b-transparent whitespace-nowrap shrink-0 hover:bg-accent transition-colors",
            isActive ? "bg-background text-foreground border-b-primary" : "text-muted-foreground",
          )}
          onClick={() => controller.setActiveFile(featureId, paneId, tab.filePath)}
        >
          <FileSymbolIcon fileName={tab.fileName} className="shrink-0 flex items-center" />
          <span>{tab.disambiguatedName}</span>
          <span
            role="button"
            aria-label={`Close ${tab.disambiguatedName}`}
            tabIndex={0}
            className="ml-0.5 rounded hover:bg-muted p-0.5 flex items-center justify-center w-4 h-4"
            onMouseEnter={() => controller.setHoveredClose(tab.filePath)}
            onMouseLeave={() => controller.setHoveredClose(null)}
            onClick={(event) => {
              event.stopPropagation();
              controller.requestClose(tab.filePath, tab.fileName, tab.isDirty);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.stopPropagation();
              controller.requestClose(tab.filePath, tab.fileName, tab.isDirty);
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
      <EditorSubTabMenu controller={controller} tab={tab} />
    </ContextMenu>
  );
}

function EditorSubTabMenu({
  controller,
  tab,
}: {
  controller: EditorSubTabsController;
  tab: EditorTab;
}) {
  return (
    <ContextMenuContent>
      <ContextMenuActionItem
        icon={X}
        onSelect={() => controller.requestClose(tab.filePath, tab.fileName, tab.isDirty)}
      >
        Close
      </ContextMenuActionItem>
      <ContextMenuActionItem
        icon={PanelRightCloseIcon}
        onSelect={() => controller.closeMany((path) => path !== tab.filePath)}
      >
        Close Others
      </ContextMenuActionItem>
      <ContextMenuActionItem
        icon={PanelRightCloseIcon}
        onSelect={() => {
          const index = controller.tabs.findIndex(
            (candidate) => candidate.filePath === tab.filePath,
          );
          controller.closeMany(
            (path) => controller.tabs.findIndex((candidate) => candidate.filePath === path) > index,
          );
        }}
      >
        Close to the Right
      </ContextMenuActionItem>
      <ContextMenuActionItem icon={X} onSelect={() => controller.closeMany(() => true)}>
        Close All
      </ContextMenuActionItem>
      <ContextMenuSeparator />
      <ContextMenuActionItem
        icon={ClipboardCopyIcon}
        shortcutId="editor-copy-path"
        onSelect={() => copyFilePath(tab.filePath)}
      >
        Copy Path
      </ContextMenuActionItem>
      <ContextMenuActionItem icon={EyeIcon} onSelect={() => void controller.reveal(tab.filePath)}>
        Reveal in File Manager
      </ContextMenuActionItem>
    </ContextMenuContent>
  );
}

function UnsavedChangesDialog({ controller }: { controller: EditorSubTabsController }) {
  return (
    <Dialog
      open={controller.pendingClose !== null}
      onOpenChange={(open) => {
        if (!open) controller.setPendingClose(null);
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Unsaved Changes</DialogTitle>
          <DialogDescription>
            You have unsaved changes in <strong>{controller.pendingClose?.fileName}</strong>.
            Discard changes?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => controller.setPendingClose(null)}>
            Cancel
          </Button>
          <Button variant="outline" onClick={controller.handleDiscard}>
            Discard
          </Button>
          <Button
            onClick={() => void controller.handleSaveAndClose()}
            disabled={controller.isSaving}
          >
            {controller.isSaving ? "Saving…" : "Save & Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

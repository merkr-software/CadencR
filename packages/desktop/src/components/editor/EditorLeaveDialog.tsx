import { useUiTranslation } from "@/lib/i18n/ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface EditorLeaveDialogState {
  cancel: () => void;
  dirtyCount: number;
  isSaving: boolean;
  open: boolean;
  saveAndSwitch: () => Promise<void>;
  switchWithoutSaving: () => void;
}

export function EditorLeaveDialog({ leave }: { leave: EditorLeaveDialogState }) {
  const { t } = useUiTranslation();
  return (
    <Dialog
      open={leave.open}
      onOpenChange={(open) => {
        if (!open) leave.cancel();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {t("workspace.editor.editorLeaveDialog.unsavedChanges", "Unsaved Changes")}
          </DialogTitle>
          <DialogDescription>
            {t("workspace.editor.editorLeaveDialog.unsavedSummary", {
              count: leave.dirtyCount,
              defaultValue_one:
                "You have unsaved changes in {{count, number}} file. Switch tab anyway?",
              defaultValue_other:
                "You have unsaved changes in {{count, number}} files. Switch tab anyway?",
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={leave.cancel}>
            {t("workspace.editor.editorLeaveDialog.cancel", "Cancel")}
          </Button>
          <Button variant="outline" onClick={leave.switchWithoutSaving}>
            {t("workspace.editor.editorLeaveDialog.switchWithoutSaving", "Switch Without Saving")}
          </Button>
          <Button onClick={() => void leave.saveAndSwitch()} disabled={leave.isSaving}>
            {leave.isSaving
              ? t("workspace.editor.editorLeaveDialog.saving", "Saving…")
              : t("workspace.editor.editorLeaveDialog.saveAndSwitch", "Save All & Switch")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useUiTranslation, UiTrans } from "@/lib/i18n/ui";
import { memo, type ReactElement } from "react";
import { Loader2Icon } from "lucide-react";
import type { StashEntry } from "@/api/generated";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface StashDropConfirmationDialogProps {
  open: boolean;
  stash: StashEntry;
  pending: boolean;
  blocked: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export const StashDropConfirmationDialog = memo(function StashDropConfirmationDialog({
  open,
  stash,
  pending,
  blocked,
  onOpenChange,
  onConfirm,
}: StashDropConfirmationDialogProps): ReactElement {
  const { t } = useUiTranslation();
  const handleOpenChange = (nextOpen: boolean): void => {
    if (!pending) onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-sm" aria-busy={pending}>
        <DialogHeader>
          <DialogTitle>
            {t("workspace.git.stashDropConfirmationDialog.dropQuestion", "Drop {{ref}}?", {
              ref: stash.ref_name,
            })}
          </DialogTitle>
          <DialogDescription>
            <UiTrans
              i18nKey="workspace.git.stashDropConfirmationDialog.dropDescription"
              defaults="Permanently drop <ref>{{ref}}</ref>: “<message>{{message}}</message>”. This cannot be undone."
              values={{ ref: stash.ref_name, message: stash.message }}
              components={{
                ref: <span className="font-mono text-foreground" />,
                message: <span className="text-foreground" />,
              }}
            />
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("workspace.git.stashDropConfirmationDialog.cancel", "Cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending || blocked}
            title={
              blocked
                ? t(
                    "workspace.git.stashDropConfirmationDialog.anotherStashOperationIsInProgress",
                    "Another stash operation is in progress",
                  )
                : undefined
            }
          >
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? t("workspace.git.stashDropConfirmationDialog.dropping", "Dropping…")
              : t("workspace.git.stashDropConfirmationDialog.dropStash", "Drop stash")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

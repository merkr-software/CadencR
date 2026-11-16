import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2Icon } from "lucide-react";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  confirmText?: string;
  variant?: "default" | "destructive";
  busy?: boolean;
  onConfirm: () => void | null | boolean | Promise<void | boolean>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmText = "Confirm",
  variant = "default",
  busy = false,
  onConfirm,
}: ConfirmDialogProps) {
  const handleConfirm = async (): Promise<void> => {
    if (busy) return;
    const confirmed = await onConfirm();
    if (confirmed !== false) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-sm"
        onKeyDown={(e) => {
          // Only the confirm control may trigger on Enter. Letting the event
          // bubble from Cancel (or any other focused element) would confirm
          // a destructive action the user explicitly declined.
          if (e.key !== "Enter" || busy) return;
          if (!(e.target instanceof HTMLElement)) return;
          if (!e.target.closest('[data-confirm-dialog-confirm="true"]')) return;
          e.preventDefault();
          void handleConfirm();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={variant}
            disabled={busy}
            aria-busy={busy}
            data-confirm-dialog-confirm="true"
            onClick={() => void handleConfirm()}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

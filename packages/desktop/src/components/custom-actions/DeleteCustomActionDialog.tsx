import type { ReactElement } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import {
  getListCustomActionsQueryKey,
  useDeleteCustomAction,
  type CustomAction,
} from "@/api/generated";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { apiErrorMessage } from "@/lib/api-errors";

interface DeleteCustomActionDialogProps {
  action: CustomAction | null;
  onClose: () => void;
  /** Called once the backend confirmed the deletion. */
  onDeleted?: () => void;
}

/** Confirms a deletion, naming how far it reaches: one project, or all of them. */
export function DeleteCustomActionDialog({
  action,
  onClose,
  onDeleted,
}: DeleteCustomActionDialogProps): ReactElement {
  const queryClient = useQueryClient();
  const deletion = useDeleteCustomAction();
  const reach =
    action?.scope === "global"
      ? "It is removed from every project, with its run history, saved values and schedules."
      : "It is removed from this project, with its run history, saved values and schedules.";
  return (
    <ConfirmDialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={action ? `Delete "${action.name}"?` : "Delete action?"}
      description={reach}
      confirmText="Delete"
      variant="destructive"
      busy={deletion.isPending}
      onConfirm={async () => {
        if (!action) return false;
        try {
          await deletion.mutateAsync({ id: action.id });
        } catch (error) {
          toast.error(
            `Could not delete ${action.name}: ${apiErrorMessage(error, "unknown error")}`,
          );
          return false;
        }
        void queryClient.invalidateQueries({ queryKey: getListCustomActionsQueryKey() });
        toast.success(`Deleted ${action.name}`);
        onDeleted?.();
        return true;
      }}
    />
  );
}

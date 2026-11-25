import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
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
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const deletion = useDeleteCustomAction();
  const reach =
    action?.scope === "global"
      ? t(
          "customActions.delete.global",
          "It is removed from every project, with its run history, saved values and schedules.",
        )
      : t(
          "customActions.delete.project",
          "It is removed from this project, with its run history, saved values and schedules.",
        );
  return (
    <ConfirmDialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        action
          ? t("customActions.delete.confirm", 'Delete "{{name}}"?', { name: action.name })
          : t("customActions.deleteCustomActionDialog.deleteAction", "Delete action?")
      }
      description={reach}
      confirmText={t("common.delete", "Delete")}
      variant="destructive"
      busy={deletion.isPending}
      onConfirm={async () => {
        if (!action) return false;
        try {
          await deletion.mutateAsync({ id: action.id });
        } catch (error) {
          toast.error(
            translateUi("customActions.delete.failed", "Could not delete {{name}}: {{error}}", {
              name: action.name,
              error: apiErrorMessage(error, translateUi("common.unknownError", "Unknown error")),
            }),
          );
          return false;
        }
        void queryClient.invalidateQueries({ queryKey: getListCustomActionsQueryKey() });
        toast.success(
          translateUi("customActions.delete.success", "Deleted {{name}}", { name: action.name }),
        );
        onDeleted?.();
        return true;
      }}
    />
  );
}

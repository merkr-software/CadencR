import { useState, type ReactElement } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, PlusIcon } from "lucide-react";

import {
  getListCustomActionsQueryKey,
  useListCustomActions,
  useReorderCustomActions,
  type CustomAction,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { ErrorRow, LoadingRow } from "@/components/settings/SettingsStateRows";
import { apiErrorMessage } from "@/lib/api-errors";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";
import { CustomActionManagerRow } from "./CustomActionManagerRow";
import { DeleteCustomActionDialog } from "./DeleteCustomActionDialog";

type ManagerScope = { scope: "global" } | { scope: "project"; projectId: number };

/** Move `id` to `toIndex`, keeping everything else in order. */
export function moveId(ids: readonly number[], id: number, toIndex: number): number[] {
  const rest = ids.filter((candidate) => candidate !== id);
  const clamped = Math.max(0, Math.min(rest.length, toIndex));
  return [...rest.slice(0, clamped), id, ...rest.slice(clamped)];
}

/**
 * One list of actions — the global ones, or one project's — to add, edit,
 * reorder (drag, or the row menu) and delete. The header shows the project's
 * actions first, then the global ones, each in this order.
 */
export function CustomActionsManager(props: ManagerScope): ReactElement {
  const projectId = props.scope === "project" ? props.projectId : null;
  const query = useListCustomActions(projectId == null ? {} : { project_id: projectId });
  const actions = (query.data ?? []).filter((action) => action.scope === props.scope);
  const reorder = useReorderInList();
  const [deleting, setDeleting] = useState<CustomAction | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const ids = actions.map((action) => action.id);
  const move = (id: number, toIndex: number): void => {
    const next = moveId(ids, id, toIndex);
    if (next.some((candidate, index) => candidate !== ids[index])) reorder.mutate(next);
  };
  const openEditor = (action?: CustomAction): void =>
    useCustomActionsUiStore.getState().openEditor({ action, projectId, defaultScope: props.scope });

  if (query.isPending) return <LoadingRow label="Loading actions…" />;
  if (query.isError) {
    return (
      <ErrorRow
        label={`Could not load actions: ${apiErrorMessage(query.error, "unknown error")}`}
      />
    );
  }
  return (
    <div className="space-y-2">
      {actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {props.scope === "global"
            ? "No action is shared by every project yet."
            : "This project has no actions of its own yet."}
        </p>
      ) : (
        <ol
          aria-label="Actions, in header order"
          className="divide-y divide-border rounded-md border"
        >
          {actions.map((action, index) => (
            <CustomActionManagerRow
              key={action.id}
              action={action}
              index={index}
              count={actions.length}
              dragging={dragged === action.id}
              onDragStart={() => setDragged(action.id)}
              onDragEnd={() => setDragged(null)}
              onDropOn={() => {
                if (dragged != null) move(dragged, index);
                setDragged(null);
              }}
              onMove={(toIndex) => move(action.id, toIndex)}
              onEdit={() => openEditor(action)}
              onDelete={() => setDeleting(action)}
            />
          ))}
        </ol>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => openEditor()}>
          <PlusIcon />
          New action
        </Button>
        {reorder.isPending && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" aria-hidden /> Saving order…
          </span>
        )}
      </div>
      <DeleteCustomActionDialog action={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function useReorderInList() {
  const queryClient = useQueryClient();
  const mutation = useReorderCustomActions({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListCustomActionsQueryKey() }),
      onError: (error) =>
        toast.error(`Could not reorder actions: ${apiErrorMessage(error, "unknown error")}`),
    },
  });
  return {
    isPending: mutation.isPending,
    mutate: (ids: number[]) => mutation.mutate({ data: { ids } }),
  };
}

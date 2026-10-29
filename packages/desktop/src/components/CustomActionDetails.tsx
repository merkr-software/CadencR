import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, PencilIcon, PlayIcon, SquareIcon, TerminalIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getGetCustomActionVariablesQueryKey,
  getListCustomActionsQueryKey,
  useCancelCustomActionRun,
  useDeleteCustomAction,
  useSetCustomActionVariable,
  type CustomAction,
  type CustomActionRun,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { invalidateCustomActionRunQueries } from "@/lib/custom-action-queries";
import { useCustomActionRunner } from "@/hooks/useCustomActionRunner";
import {
  useCustomActionRuns,
  useCustomActionVariableDrafts,
  type CustomActionVariableDrafts,
} from "@/hooks/useCustomActionDetailsQueries";
import { BashBlock } from "./BashBlock";
import { CustomActionScheduleControl } from "./CustomActionScheduleControl";

/**
 * Merge a run's captured streams into a single terminal-style body. We capture
 * stdout/stderr separately but the shared bash block renders one stream (as a
 * terminal would); stderr is appended after stdout.
 */
function runOutput(run: CustomActionRun): string {
  return [run.stdout, run.stderr].filter(Boolean).join("\n");
}

interface CustomActionDetailsProps {
  action: CustomAction;
  featureId: number;
  projectId: number;
  /** Open the editor dialog in edit mode for this action. */
  onEdit: () => void;
  /** Close the surrounding surface after an action that should dismiss it (e.g. delete). */
  onAfterDelete: () => void;
}

/**
 * Unified run/output/details surface for a custom action, shown identically for
 * inline and overflow actions. Polls the action's recent runs so live output
 * (manual or scheduled) streams in without a manual refresh, and exposes the
 * run button, per-feature variables and the schedule control.
 */
export function CustomActionDetails({
  action,
  featureId,
  projectId,
  onEdit,
  onAfterDelete,
}: CustomActionDetailsProps) {
  const controller = useCustomActionDetailsController({
    action,
    featureId,
    projectId,
    onAfterDelete,
  });
  return (
    <div className="space-y-3">
      <CustomActionDetailsHeader
        action={action}
        onEdit={onEdit}
        onDelete={controller.deleteAction}
        isDeleting={controller.isDeleting}
      />
      <CustomActionVariables
        action={action}
        variables={controller.variables}
        saveVariable={controller.saveVariable}
      />
      <CustomActionRunControl action={action} controller={controller} />
      <section className="rounded border border-dashed p-2">
        <CustomActionScheduleControl actionId={action.id} featureId={featureId} />
      </section>
      <CustomActionRunHistory action={action} runViews={controller.runViews} />
    </div>
  );
}

function useCancelRunMutation({
  actionId,
  featureId,
  projectId,
  queryClient,
  clearCancelling,
}: {
  actionId: number;
  featureId: number;
  projectId: number;
  queryClient: ReturnType<typeof useQueryClient>;
  clearCancelling: () => void;
}) {
  return useCancelCustomActionRun({
    mutation: {
      onSuccess: () =>
        invalidateCustomActionRunQueries({ queryClient, projectId, actionId, featureId }),
      onError: (error) => {
        clearCancelling();
        toast.error(`Stop failed: ${apiErrorMessage(error, "the run could not be stopped")}`);
      },
    },
  });
}

function useCustomActionDetailsController({
  action,
  featureId,
  projectId,
  onAfterDelete,
}: Omit<CustomActionDetailsProps, "onEdit">) {
  const queryClient = useQueryClient();
  const runsQuery = useCustomActionRuns(action, featureId);
  const latestRun = runsQuery.data?.[0];
  const isRunning = latestRun != null && latestRun.ended_at == null;
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const { run, isStarting } = useCustomActionRunner({ action, featureId, projectId });
  const cancelMutation = useCancelRunMutation({
    actionId: action.id,
    featureId,
    projectId,
    queryClient,
    clearCancelling: () => setCancellingId(null),
  });
  const isStopping = isRunning && latestRun != null && cancellingId === latestRun.id;
  const setVariableMutation = useSetCustomActionVariable({
    mutation: {
      onSuccess: (_data, request) => {
        queryClient.invalidateQueries({
          queryKey: getGetCustomActionVariablesQueryKey(request.id, request.params),
        });
      },
      onError: (err) =>
        toast.error(`Saving variable failed: ${apiErrorMessage(err, "unknown error")}`),
    },
  });
  const deleteMutation = useDeleteCustomAction({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getListCustomActionsQueryKey({ project_id: projectId, feature_id: featureId }),
        });
        onAfterDelete();
        toast.success("Action deleted");
      },
      onError: (err) => toast.error(`Delete failed: ${apiErrorMessage(err, "unknown error")}`),
    },
  });
  const runViews = useMemo(
    () => (runsQuery.data ?? []).map((run) => ({ run, output: runOutput(run) })),
    [runsQuery.data],
  );
  const variables = useCustomActionVariableDrafts(action.id, featureId);
  return useMemo(
    () => ({
      cancelRun: () => {
        if (!latestRun) return;
        setCancellingId(latestRun.id);
        cancelMutation.mutate({ id: action.id, runId: latestRun.id });
      },
      deleteAction: () => deleteMutation.mutate({ id: action.id }),
      isDeleting: deleteMutation.isPending,
      isRunning,
      isStarting,
      isStopping,
      latestRun,
      run,
      runViews,
      saveVariable: (name: string) => {
        if (!variables.isDirty(name)) return;
        setVariableMutation.mutate({
          id: action.id,
          params: { feature_id: featureId },
          data: { var_name: name, value: variables.valueOf(name) },
        });
      },
      variables,
    }),
    [
      action.id,
      cancelMutation,
      deleteMutation,
      featureId,
      isRunning,
      isStarting,
      isStopping,
      latestRun,
      run,
      runViews,
      setVariableMutation,
      variables,
    ],
  );
}

type CustomActionDetailsController = ReturnType<typeof useCustomActionDetailsController>;

function CustomActionDetailsHeader({
  action,
  onEdit,
  onDelete,
  isDeleting,
}: {
  action: CustomAction;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  return (
    <header className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold truncate">{action.name}</h3>
        <p className="text-xs text-muted-foreground truncate">
          <span className="font-mono">{action.command}</span>
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button variant="ghost" size="icon" className="size-7" title="Edit action" onClick={onEdit}>
          <PencilIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-destructive"
          title="Delete action"
          onClick={onDelete}
          disabled={isDeleting}
        >
          {isDeleting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Trash2Icon className="size-3.5" />
          )}
        </Button>
      </div>
    </header>
  );
}

function CustomActionVariables({
  action,
  variables,
  saveVariable,
}: {
  action: CustomAction;
  variables: CustomActionVariableDrafts;
  saveVariable: (name: string) => void;
}) {
  if (action.variable_names.length === 0) return null;
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">
        Variables
      </h4>
      <div className="space-y-2">
        {action.variable_names.map((name) => (
          <label key={name} className="block space-y-1">
            <span className="block font-mono text-xs text-foreground">${`{${name}}`}</span>
            <Input
              value={variables.valueOf(name)}
              onChange={(event) => variables.setDraft(name, event.target.value)}
              onBlur={() => saveVariable(name)}
              className="h-8 text-xs"
            />
          </label>
        ))}
      </div>
    </section>
  );
}

function CustomActionRunControl({
  action,
  controller,
}: {
  action: CustomAction;
  controller: CustomActionDetailsController;
}) {
  if (action.run_in_terminal) {
    return (
      <Button
        size="sm"
        onClick={controller.run}
        disabled={controller.isStarting}
        className="w-full"
      >
        {controller.isStarting ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <TerminalIcon className="size-3.5" />
        )}
        {controller.isStarting ? "Starting…" : "Run in terminal"}
      </Button>
    );
  }
  if (controller.isRunning && controller.latestRun) {
    return (
      <Button
        size="sm"
        variant="destructive"
        onClick={controller.cancelRun}
        disabled={controller.isStopping}
        className="w-full"
        title="Stop the running command (Ctrl-C)"
      >
        {controller.isStopping ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <SquareIcon className="size-3.5 fill-current" />
        )}
        {controller.isStopping ? "Stopping…" : "Stop"}
      </Button>
    );
  }
  return (
    <Button size="sm" onClick={controller.run} disabled={controller.isStarting} className="w-full">
      {controller.isStarting ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <PlayIcon className="size-3.5" />
      )}
      {controller.isStarting ? "Starting…" : "Run now"}
    </Button>
  );
}

function CustomActionRunHistory({
  action,
  runViews,
}: {
  action: CustomAction;
  runViews: Array<{ run: CustomActionRun; output: string }>;
}) {
  return (
    <section className="space-y-1.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground/70">
        Recent runs
      </h4>
      {runViews.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No runs yet.</p>
      ) : (
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {runViews.map(({ run, output }) => (
            <div key={run.id} className="space-y-1 text-xs">
              <div className="font-mono text-[11px] text-muted-foreground">
                {run.started_at} · {run.triggered_by}
              </div>
              <BashBlock
                command={action.command}
                content={output}
                running={run.ended_at == null}
                isError={run.exit_code != null && run.exit_code !== 0}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

import { useState, type ReactElement } from "react";
import {
  CalendarClockIcon,
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react";

import { useGetCustomActionRuns, type CustomAction, type CustomActionRun } from "@/api/generated";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIsActionStarting } from "@/hooks/useFeatureCustomActions";
import { useOpenScheduleEditorForAction } from "@/hooks/useOpenScheduleEditorForAction";
import { apiErrorMessage } from "@/lib/api-errors";
import { launchCustomAction, stopCustomActionRun } from "@/lib/custom-actions/launch";
import { describeRun, runOutcomeText } from "@/lib/custom-actions/run-history";
import { runStateOf } from "@/lib/custom-actions/run-state";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";
import { CustomActionIcon } from "./CustomActionIcon";
import { CustomActionRunOutput } from "./CustomActionRunOutput";
import { RunStateDot } from "./RunStateDot";

const HISTORY_LIMIT = 20;

interface CustomActionRunPanelProps {
  action: CustomAction;
  featureId: number;
  projectId: number;
}

/** One action's runs in a conversation: controls, the chosen run's output, history. */
export function CustomActionRunPanel({
  action,
  featureId,
  projectId,
}: CustomActionRunPanelProps): ReactElement {
  const target = { action, featureId, projectId };
  const openScheduleEditor = useOpenScheduleEditorForAction();
  return (
    <section aria-label={`${action.name} runs`} className="flex min-h-0 flex-1 flex-col gap-3">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <CustomActionIcon iconData={action.icon_data} name={action.name} />
            <span className="truncate">{action.name}</span>
          </h2>
          <p
            className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
            title={action.command}
          >
            {action.command}
          </p>
        </div>
        {!action.run_in_terminal && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openScheduleEditor({ projectId, featureId, actionId: action.id })}
          >
            <CalendarClockIcon />
            Schedule…
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            useCustomActionsUiStore.getState().openEditor({
              action,
              projectId,
              defaultScope: action.scope,
            })
          }
        >
          <PencilIcon />
          Edit
        </Button>
        {action.variable_names.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={!action.run_in_terminal && runStateOf(action.last_run) === "running"}
            title="Change the values, then run"
            onClick={() => void launchCustomAction(target, { promptVariables: true })}
          >
            Run with…
          </Button>
        )}
      </header>
      {action.run_in_terminal ? (
        <TerminalActionNotice action={action} featureId={featureId} projectId={projectId} />
      ) : (
        <RunHistoryView action={action} featureId={featureId} projectId={projectId} />
      )}
    </section>
  );
}

function TerminalActionNotice({ action, featureId, projectId }: CustomActionRunPanelProps) {
  const starting = useIsActionStarting(action, featureId);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <TerminalIcon className="size-7 text-muted-foreground" aria-hidden />
      <p className="max-w-sm text-sm text-muted-foreground">
        {action.name} runs in this conversation&apos;s terminal, where you can watch, type into and
        stop it.
      </p>
      <Button
        size="sm"
        disabled={starting}
        onClick={() => void launchCustomAction({ action, featureId, projectId })}
      >
        {starting ? <Loader2Icon className="animate-spin" /> : <TerminalIcon />}
        {starting ? "Starting…" : "Run in terminal"}
      </Button>
    </div>
  );
}

function RunHistoryView({ action, featureId, projectId }: CustomActionRunPanelProps) {
  const runsQuery = useGetCustomActionRuns(
    action.id,
    { feature_id: featureId, limit: HISTORY_LIMIT },
    { query: { refetchOnMount: "always" } },
  );
  const [pickedRunId, setPickedRunId] = useState<number | null>(null);
  const runs = runsQuery.data ?? [];
  // A new run takes over the view unless the user is reading an older one.
  const shown = runs.find((run) => run.id === pickedRunId) ?? runs[0] ?? null;

  if (runsQuery.isPending) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" aria-hidden /> Loading runs…
      </p>
    );
  }
  if (runsQuery.isError) {
    return (
      <p role="alert" className="text-sm text-[var(--acc-red)]">
        Could not load runs: {apiErrorMessage(runsQuery.error, "unknown error")}
      </p>
    );
  }
  return (
    <>
      <RunControls
        action={action}
        featureId={featureId}
        projectId={projectId}
        runs={runs}
        shown={shown}
        onPick={(runId) => setPickedRunId(runId === runs[0]?.id ? null : runId)}
      />
      {shown ? (
        <CustomActionRunOutput run={shown} />
      ) : (
        <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No runs in this conversation yet.
        </p>
      )}
    </>
  );
}

interface RunControlsProps extends CustomActionRunPanelProps {
  runs: CustomActionRun[];
  shown: CustomActionRun | null;
  onPick: (runId: number) => void;
}

function RunControls({ action, featureId, projectId, runs, shown, onPick }: RunControlsProps) {
  const starting = useIsActionStarting(action, featureId);
  const [stoppingRunId, setStoppingRunId] = useState<number | null>(null);
  const latest = runs[0] ?? null;
  const running = latest != null && latest.ended_at == null;
  const target = { action, featureId, projectId };
  return (
    <div className="flex flex-wrap items-center gap-2">
      {running && latest ? (
        <Button
          size="sm"
          variant="outline"
          disabled={stoppingRunId === latest.id}
          onClick={() => {
            setStoppingRunId(latest.id);
            void stopCustomActionRun(target, latest.id).finally(() => setStoppingRunId(null));
          }}
        >
          {stoppingRunId === latest.id ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <SquareIcon className="fill-current" />
          )}
          {stoppingRunId === latest.id ? "Stopping…" : "Stop"}
        </Button>
      ) : (
        <Button size="sm" disabled={starting} onClick={() => void launchCustomAction(target)}>
          {starting ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
          {starting ? "Starting…" : latest ? "Run again" : "Run"}
        </Button>
      )}
      {shown && (
        <span
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          aria-live="polite"
        >
          <RunStateDot run={shown} />
          {runOutcomeText(shown)}
        </span>
      )}
      {runs.length > 1 && shown && (
        <Select value={String(shown.id)} onValueChange={(value) => onPick(Number(value))}>
          <SelectTrigger size="sm" className="ml-auto h-7 text-xs" aria-label="Run to show">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {runs.map((run, index) => (
              <SelectItem key={run.id} value={String(run.id)} className="text-xs">
                {index === 0 ? "Latest · " : ""}
                {describeRun(run)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

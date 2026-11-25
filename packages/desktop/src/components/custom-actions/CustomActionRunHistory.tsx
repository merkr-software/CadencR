import { useUiTranslation } from "@/lib/i18n/ui";
import { useState, type ReactElement } from "react";
import { Loader2Icon, PlayIcon, SquareIcon, TerminalIcon, TextCursorInputIcon } from "lucide-react";

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
import { apiErrorMessage } from "@/lib/api-errors";
import { launchCustomAction, stopCustomActionRun } from "@/lib/custom-actions/launch";
import { describeRun, runOutcomeText } from "@/lib/custom-actions/run-history";
import { cn } from "@/lib/utils";
import { CustomActionRunOutput } from "./CustomActionRunOutput";
import { RunStateDot } from "./RunStateDot";

const HISTORY_LIMIT = 20;

export interface CustomActionRunHistoryProps {
  action: CustomAction;
  featureId: number;
  projectId: number;
  /** Height of the output (and of the empty / loading states standing in for it). */
  outputClassName: string;
  /** Close the menu: a terminal action is about to show in the terminal tab. */
  onLeave: () => void;
}

/**
 * One action's runs in a conversation: Run / Stop, the chosen run's live
 * output and the last runs to pick from. A terminal action runs in the
 * conversation's terminal instead, so it only gets a way to start it there.
 */
export function CustomActionRunHistory(props: CustomActionRunHistoryProps): ReactElement {
  return props.action.run_in_terminal ? (
    <TerminalActionNotice {...props} />
  ) : (
    <RunHistoryView {...props} />
  );
}

function TerminalActionNotice({
  action,
  featureId,
  projectId,
  outputClassName,
  onLeave,
}: CustomActionRunHistoryProps): ReactElement {
  const starting = useIsActionStarting(action, featureId);
  const { t } = useUiTranslation();
  const target = { action, featureId, projectId };
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-md border border-dashed px-4 text-center",
        outputClassName,
      )}
    >
      <TerminalIcon className="size-6 text-muted-foreground" aria-hidden />
      <p className="max-w-sm text-sm text-muted-foreground">
        {t(
          "customActions.history.terminalHelp",
          "{{name}} runs in this conversation's terminal, where you can watch, type into and stop it.",
          { name: action.name },
        )}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          size="sm"
          disabled={starting}
          onClick={() => {
            onLeave();
            void launchCustomAction(target);
          }}
        >
          {starting ? <Loader2Icon className="animate-spin" /> : <TerminalIcon />}
          {starting
            ? t("customActions.starting", "Starting…")
            : t("customActions.runInTerminal", "Run in terminal")}
        </Button>
        {action.variable_names.length > 0 && (
          <RunWithButton
            onClick={() => {
              onLeave();
              void launchCustomAction(target, { promptVariables: true });
            }}
          />
        )}
      </div>
    </div>
  );
}

function RunHistoryView(props: CustomActionRunHistoryProps): ReactElement {
  const { t } = useUiTranslation();
  const { action, featureId, outputClassName } = props;
  // Every run event invalidates this query, so a reopened page only refetches
  // when something changed.
  const runsQuery = useGetCustomActionRuns(action.id, {
    feature_id: featureId,
    limit: HISTORY_LIMIT,
  });
  const [pickedRunId, setPickedRunId] = useState<number | null>(null);
  const runs = runsQuery.data ?? [];
  // A new run takes over the view unless the user is reading an older one.
  const shown = runs.find((run) => run.id === pickedRunId) ?? runs[0] ?? null;

  if (runsQuery.isPending) {
    return (
      <p
        className={cn(
          "flex items-center justify-center gap-2 text-sm text-muted-foreground",
          outputClassName,
        )}
      >
        <Loader2Icon className="size-4 animate-spin" aria-hidden />{" "}
        {t("customActions.customActionRunHistory.loadingRuns", "Loading runs…")}
      </p>
    );
  }
  if (runsQuery.isError) {
    return (
      <p role="alert" className="text-sm text-[var(--acc-red)]">
        {t("customActions.history.loadFailed", "Could not load runs: {{error}}", {
          error: apiErrorMessage(runsQuery.error, t("common.unknownError", "Unknown error")),
        })}
      </p>
    );
  }
  return (
    <>
      <RunControls
        {...props}
        runs={runs}
        shown={shown}
        onPick={(runId) => setPickedRunId(runId === runs[0]?.id ? null : runId)}
      />
      {shown ? (
        <CustomActionRunOutput run={shown} className={outputClassName} />
      ) : (
        <p
          className={cn(
            "flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground",
            outputClassName,
          )}
        >
          {t(
            "customActions.customActionRunHistory.noRunsInThisConversationYet",
            "No runs in this conversation yet.",
          )}
        </p>
      )}
    </>
  );
}

interface RunControlsProps extends CustomActionRunHistoryProps {
  runs: CustomActionRun[];
  shown: CustomActionRun | null;
  onPick: (runId: number) => void;
}

function RunControls({
  action,
  featureId,
  projectId,
  runs,
  shown,
  onPick,
}: RunControlsProps): ReactElement {
  const { t } = useUiTranslation();
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
          {stoppingRunId === latest.id
            ? t("customActions.stopping", "Stopping…")
            : t("customActions.stop", "Stop")}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={starting}
          onClick={() => void launchCustomAction(target, { showOutput: true })}
        >
          {starting ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
          {starting
            ? t("customActions.starting", "Starting…")
            : latest
              ? t("customActions.runAgain", "Run again")
              : t("customActions.run", "Run")}
        </Button>
      )}
      {action.variable_names.length > 0 && (
        <RunWithButton
          disabled={running}
          onClick={() =>
            void launchCustomAction(target, { promptVariables: true, showOutput: true })
          }
        />
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
          <SelectTrigger
            size="sm"
            className="ml-auto h-7 text-xs"
            aria-label={t("customActions.customActionRunHistory.runToShow", "Run to show")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {runs.map((run, index) => (
              <SelectItem key={run.id} value={String(run.id)} className="text-xs">
                {index === 0
                  ? t("customActions.history.latest", "Latest · {{run}}", { run: describeRun(run) })
                  : describeRun(run)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function RunWithButton({
  disabled = false,
  onClick,
}: {
  disabled?: boolean;
  onClick: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={disabled}
      title={t(
        "customActions.customActionRunHistory.changeTheValuesThenRun",
        "Change the values, then run",
      )}
      onClick={onClick}
    >
      <TextCursorInputIcon />
      {t("customActions.customActionRunHistory.runWith", "Run with…")}
    </Button>
  );
}

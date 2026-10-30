import { toast } from "sonner";

import {
  cancelCustomActionRun,
  getCustomActionRuns,
  getGetCustomActionVariablesQueryOptions,
  getGetCustomActionVariablesQueryKey,
  resolveCommand,
  runCustomAction,
  setCustomActionVariable,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { invalidateCustomActionRunQueries } from "@/lib/custom-action-queries";
import { queryClient } from "@/lib/queryClient";
import { STOPPED_EXIT_CODE } from "./run-state";
import { useTerminalStore } from "@/hooks/useTerminalState";
import { activateFeatureTab } from "@/stores/feature-layout-store";
import {
  useCustomActionsUiStore,
  type CustomActionLaunchTarget,
} from "@/stores/custom-actions-ui-store";

/** Variables the command references that have no non-blank value. */
export function missingVariables(
  names: readonly string[],
  values: Record<string, string>,
): string[] {
  return names.filter((name) => (values[name] ?? "").trim() === "");
}

async function storedVariables(target: CustomActionLaunchTarget): Promise<Record<string, string>> {
  const stored = await queryClient.fetchQuery(
    getGetCustomActionVariablesQueryOptions(target.action.id, { feature_id: target.featureId }),
  );
  return Object.fromEntries(stored.map((variable) => [variable.var_name, variable.value]));
}

/**
 * Run an action in a conversation — the one entry point for the launcher, its
 * menu, the command palette and the shortcuts.
 *
 * An action whose `${VAR}`s are not all set for this conversation asks for
 * them first (and so does `promptVariables`, the "Run with…" gesture), so a
 * run never starts only to fail on a missing value.
 */
export async function launchCustomAction(
  target: CustomActionLaunchTarget,
  options: { promptVariables?: boolean } = {},
): Promise<void> {
  const { action } = target;
  if (action.variable_names.length > 0) {
    let values: Record<string, string>;
    try {
      values = await storedVariables(target);
    } catch (error) {
      toast.error(`${action.name}: ${apiErrorMessage(error, "could not read its variables")}`);
      return;
    }
    if (options.promptVariables || missingVariables(action.variable_names, values).length > 0) {
      useCustomActionsUiStore.getState().openVariablesPrompt({ target, values });
      return;
    }
  }
  await startCustomAction(target);
}

/** Save the values typed in the variables dialog, then run. */
export async function saveVariablesAndLaunch(
  target: CustomActionLaunchTarget,
  values: Record<string, string>,
  stored: Record<string, string>,
): Promise<void> {
  const changed = Object.entries(values).filter(([name, value]) => stored[name] !== value);
  await Promise.all(
    changed.map(([name, value]) =>
      setCustomActionVariable(
        target.action.id,
        { var_name: name, value },
        { feature_id: target.featureId },
      ),
    ),
  );
  void queryClient.invalidateQueries({
    queryKey: getGetCustomActionVariablesQueryKey(target.action.id, {
      feature_id: target.featureId,
    }),
  });
  await startCustomAction(target);
}

async function startCustomAction(target: CustomActionLaunchTarget): Promise<void> {
  const { action, featureId, projectId } = target;
  const store = useCustomActionsUiStore.getState();
  store.setStarting(action.id, featureId, true);
  try {
    if (action.run_in_terminal) {
      const { command } = await resolveCommand(action.id, { feature_id: featureId });
      // Written verbatim to a fresh terminal split: the newline executes it.
      useTerminalStore.getState().sendToTerminal(featureId, `${command}\n`);
      activateFeatureTab(featureId, "terminal");
      return;
    }
    const { run_id: runId } = await runCustomAction(action.id, { feature_id: featureId });
    store.trackRun(runId, { actionId: action.id, actionName: action.name, featureId });
    store.showInRunsTab(featureId, action.id);
    invalidateCustomActionRunQueries({ queryClient, projectId, actionId: action.id, featureId });
  } catch (error) {
    toast.error(`${action.name} did not start: ${apiErrorMessage(error, "unknown error")}`);
  } finally {
    useCustomActionsUiStore.getState().setStarting(action.id, featureId, false);
  }
}

/** Interrupt a background run (Ctrl-C, escalating to SIGKILL server-side). */
export async function stopCustomActionRun(
  target: CustomActionLaunchTarget,
  runId: number,
): Promise<void> {
  try {
    await cancelCustomActionRun(target.action.id, runId);
  } catch (error) {
    toast.error(`Could not stop ${target.action.name}: ${apiErrorMessage(error, "unknown error")}`);
  }
}

/** Bring a conversation's Actions tab forward on an action's output. */
export function showCustomActionOutput(featureId: number, actionId: number): void {
  useCustomActionsUiStore.getState().showInRunsTab(featureId, actionId);
  activateFeatureTab(featureId, "runs");
}

/**
 * Announce the end of a background run this client started, with a way back
 * to its output. Runs started elsewhere (a schedule, another device) only
 * update the launcher's status.
 */
export async function announceFinishedRun(runId: number): Promise<void> {
  const tracked = useCustomActionsUiStore.getState().untrackRun(runId);
  if (!tracked) return;
  const showOutput = {
    label: "Show output",
    onClick: () => showCustomActionOutput(tracked.featureId, tracked.actionId),
  };
  try {
    const runs = await getCustomActionRuns(tracked.actionId, {
      feature_id: tracked.featureId,
      limit: 5,
    });
    const run = runs.find((candidate) => candidate.id === runId);
    if (run?.exit_code === 0) {
      toast.success(`${tracked.actionName} passed`, { action: showOutput });
    } else if (run?.exit_code === STOPPED_EXIT_CODE) {
      toast(`${tracked.actionName} stopped`, { action: showOutput });
    } else {
      const exit = run?.exit_code == null ? "" : ` (exit ${run.exit_code})`;
      toast.error(`${tracked.actionName} failed${exit}`, { action: showOutput });
    }
  } catch (error) {
    toast.error(`${tracked.actionName} finished, but its result could not be read`, {
      description: apiErrorMessage(error, "unknown error"),
      action: showOutput,
    });
  }
}

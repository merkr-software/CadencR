import { useEffect, useMemo } from "react";

import type { CustomAction } from "@/api/generated";
import { useGlobalShortcutById } from "@/hooks/useShortcut";
import {
  launchCustomAction,
  showCustomActionOutput,
  stopCustomActionRun,
} from "@/lib/custom-actions/launch";
import { publishCustomActionCommands } from "@/lib/custom-actions/palette-commands";
import { aggregateRunState, runStateOf } from "@/lib/custom-actions/run-state";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";
import { CustomActionIcon } from "./CustomActionIcon";

interface LauncherArgs {
  actions: readonly CustomAction[];
  featureId: number;
  projectId: number;
  openMenu: () => void;
  /** Shortcuts and palette commands are bound only where the launcher is the conversation's. */
  bindKeys: boolean;
}

/**
 * The click on an action: run it, or — while it runs in the background —
 * open its details on the output.
 */
export function activateAction(action: CustomAction, featureId: number, projectId: number): void {
  useCustomActionsUiStore.getState().selectAction(projectId, action.id);
  if (!action.run_in_terminal && runStateOf(action.last_run) === "running") {
    showCustomActionOutput({ featureId, projectId, actionId: action.id });
    return;
  }
  void launchCustomAction({ action, featureId, projectId });
}

/**
 * State and bindings behind the header launcher: the selected action (the
 * last one run in this project, else the first), the aggregate status, the
 * ⌥⌘R / ⌥⌘1–9 shortcuts and the palette's `Run: <action>` commands.
 */
export function useCustomActionsLauncher({
  actions,
  featureId,
  projectId,
  openMenu,
  bindKeys,
}: LauncherArgs) {
  const selectedId = useCustomActionsUiStore((state) => state.selectedByProject[projectId]);
  const selected = actions.find((action) => action.id === selectedId) ?? actions[0] ?? null;
  const aggregate = aggregateRunState(actions);

  useGlobalShortcutById(
    "custom-actions",
    (event) => {
      event.preventDefault();
      openMenu();
    },
    { enabled: bindKeys },
  );
  useGlobalShortcutById(
    "custom-action-run-1-9",
    (event) => {
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      const action = digit ? actions[Number(digit) - 1] : undefined;
      if (!action) return;
      event.preventDefault();
      activateAction(action, featureId, projectId);
    },
    { enabled: bindKeys && actions.length > 0 },
  );

  const commands = useMemo(
    () =>
      actions.map((action) => ({
        id: `custom-action-${action.id}`,
        title: `Run: ${action.name}`,
        group: "Conversation" as const,
        icon: (
          <CustomActionIcon iconData={action.icon_data} name={action.name} className="size-4" />
        ),
        keywords: ["custom action", "run", "task", action.command],
        description: action.command,
        run: () => activateAction(action, featureId, projectId),
      })),
    [actions, featureId, projectId],
  );
  useEffect(
    () => (bindKeys ? publishCustomActionCommands(commands) : undefined),
    [bindKeys, commands],
  );

  const primary = useMemo(() => {
    if (!selected) return null;
    const running = !selected.run_in_terminal && runStateOf(selected.last_run) === "running";
    const runId = selected.last_run?.run_id;
    return {
      action: selected,
      running,
      trigger: (): void => {
        if (running && runId != null) {
          void stopCustomActionRun({ action: selected, featureId, projectId }, runId);
          return;
        }
        activateAction(selected, featureId, projectId);
      },
    };
  }, [featureId, projectId, selected]);

  return { selected, aggregate, primary };
}

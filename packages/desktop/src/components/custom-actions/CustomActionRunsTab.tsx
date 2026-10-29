import { memo, type ReactElement } from "react";
import { PlusIcon, Settings2Icon } from "lucide-react";
import { Link } from "@tanstack/react-router";

import type { CustomAction } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { useFeatureCustomActions } from "@/hooks/useFeatureCustomActions";
import { runStateText } from "@/lib/custom-actions/run-state";
import { cn } from "@/lib/utils";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";
import { CustomActionIcon } from "./CustomActionIcon";
import { CustomActionRunPanel } from "./CustomActionRunPanel";
import { RunStateDot } from "./RunStateDot";

interface CustomActionRunsTabProps {
  featureId: number;
  projectId: number;
}

/**
 * The Runs tab: every custom action of the conversation on the left with its
 * latest outcome, the chosen one's output and history on the right. It is
 * where a background run's output lives, so closing a menu never hides it.
 */
export const CustomActionRunsTab = memo(function CustomActionRunsTab({
  featureId,
  projectId,
}: CustomActionRunsTabProps): ReactElement {
  const { data: actions = [] } = useFeatureCustomActions(projectId, featureId);
  const pickedId = useCustomActionsUiStore((state) => state.runsTabActionByFeature[featureId]);
  const selected = actions.find((action) => action.id === pickedId) ?? defaultAction(actions);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 md:flex-row md:p-4">
      <nav
        aria-label="Custom actions"
        className="flex shrink-0 flex-col gap-1 md:w-56 md:border-r md:border-border md:pr-3"
      >
        <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {actions.map((action) => (
            <li key={action.id}>
              <ActionRailItem
                action={action}
                current={action.id === selected?.id}
                onSelect={() =>
                  useCustomActionsUiStore.getState().showInRunsTab(featureId, action.id)
                }
              />
            </li>
          ))}
        </ul>
        <div className="mt-auto hidden flex-col gap-1 pt-2 md:flex">
          <Button
            variant="ghost"
            size="sm"
            className="justify-start text-muted-foreground"
            onClick={() =>
              useCustomActionsUiStore.getState().openEditor({ projectId, defaultScope: "project" })
            }
          >
            <PlusIcon />
            New action
          </Button>
          <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" asChild>
            <Link to="/settings" search={{ section: "actions" }}>
              <Settings2Icon />
              Manage actions
            </Link>
          </Button>
        </div>
      </nav>
      {selected ? (
        <CustomActionRunPanel
          key={selected.id}
          action={selected}
          featureId={featureId}
          projectId={projectId}
        />
      ) : (
        <p className="m-auto text-sm text-muted-foreground">This project has no custom actions.</p>
      )}
    </div>
  );
});

/** The action most worth looking at: one running, else one that failed, else the first. */
function defaultAction(actions: readonly CustomAction[]): CustomAction | undefined {
  return (
    actions.find((action) => action.last_run != null && action.last_run.ended_at == null) ??
    actions.find(
      (action) => action.last_run?.exit_code != null && action.last_run.exit_code !== 0,
    ) ??
    actions[0]
  );
}

function ActionRailItem({
  action,
  current,
  onSelect,
}: {
  action: CustomAction;
  current: boolean;
  onSelect: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full min-w-40 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:min-w-0",
        current && "bg-accent",
      )}
    >
      <CustomActionIcon iconData={action.icon_data} name={action.name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{action.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {action.run_in_terminal ? "Runs in the terminal" : runStateText(action.last_run)}
        </span>
      </span>
      {!action.run_in_terminal && <RunStateDot run={action.last_run} />}
    </button>
  );
}

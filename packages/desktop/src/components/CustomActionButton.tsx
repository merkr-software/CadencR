import { memo, type ReactElement } from "react";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { type CustomAction } from "@/api/generated";
import { useCustomActionRunner } from "@/hooks/useCustomActionRunner";
import { CustomActionIcon } from "./CustomActionIcon";
import { CustomActionStatusDot, customActionStatus } from "./CustomActionStatusDot";

interface CustomActionButtonProps {
  action: CustomAction;
  featureId: number;
  projectId: number;
  /** Bar-level callback to open the shared details/output surface for this action. */
  onOpenDetails: (action: CustomAction) => void;
  /** Whether the shared details surface is currently showing this action. */
  detailsOpen: boolean;
}

/**
 * Inline split button for a single custom action: the icon runs the action, the
 * chevron opens the shared details/output surface (owned by the bar). Run
 * status comes from the bar's single list query — kept live by a poll while a
 * run is in flight — so the dot stays accurate after the details popover
 * closes, without polling per button.
 *
 * Memoized because the bar re-renders on every poll tick while a run is active;
 * react-query's structural sharing keeps unchanged `action` objects stable, so
 * only the running action's button actually re-renders.
 */
function CustomActionButtonInner({
  action,
  featureId,
  projectId,
  onOpenDetails,
  detailsOpen,
}: CustomActionButtonProps): ReactElement {
  const { run, isStarting } = useCustomActionRunner({ action, featureId, projectId });
  const runTitle = action.run_in_terminal ? `Run ${action.name} in terminal` : `Run ${action.name}`;
  const status = customActionStatus(action.last_run ?? null, isStarting);

  return (
    <div className="inline-flex items-center">
      <Button
        variant="ghost"
        size="icon"
        className="relative size-7 rounded-r-none text-xs"
        title={runTitle}
        aria-label={status.color == null ? runTitle : `${runTitle}. ${status.label}`}
        onClick={run}
        disabled={isStarting}
      >
        <CustomActionIcon
          iconData={action.icon_data ?? null}
          name={action.name}
          className="size-3.5"
        />
        <CustomActionStatusDot lastRun={action.last_run ?? null} isRunning={isStarting} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-5 rounded-l-none px-0 text-xs"
        title={`Open ${action.name} details`}
        aria-haspopup="dialog"
        aria-expanded={detailsOpen}
        onClick={() => onOpenDetails(action)}
      >
        <ChevronDownIcon className="size-3" />
      </Button>
    </div>
  );
}

export const CustomActionButton = memo(CustomActionButtonInner);

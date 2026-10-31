import type { ReactElement, ReactNode } from "react";
import { ChevronRightIcon, Loader2Icon, PlayIcon, SquareIcon, TerminalIcon } from "lucide-react";

import type { CustomAction } from "@/api/generated";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useIsActionStarting } from "@/hooks/useFeatureCustomActions";
import { stopCustomActionRun } from "@/lib/custom-actions/launch";
import {
  runStateOf,
  runStateText,
  type CustomActionRunState,
} from "@/lib/custom-actions/run-state";
import { cn } from "@/lib/utils";
import { CustomActionIcon } from "./CustomActionIcon";
import { RunStateDot } from "./RunStateDot";
import { activateAction } from "./useCustomActionsLauncher";

interface MobileCustomActionsSheetProps {
  actions: readonly CustomAction[];
  featureId: number;
  projectId: number;
  aggregate: CustomActionRunState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowDetails: (actionId: number) => void;
  /** The details page of one action, shown instead of the list. */
  details: ReactNode;
}

/**
 * Phones get a bottom sheet instead of the split button: one 44px row per
 * action to run or stop it and see where it stands, and a page per action
 * with its output, runs and settings.
 */
export function MobileCustomActionsSheet({
  actions,
  featureId,
  projectId,
  aggregate,
  open,
  onOpenChange,
  onShowDetails,
  details,
}: MobileCustomActionsSheetProps): ReactElement {
  const flagged = aggregate === "running" || aggregate === "failed";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className="relative border-border/80 bg-muted/20 text-xs"
          aria-label={
            flagged
              ? `Actions, ${aggregate === "running" ? "one running" : "one failed"}`
              : "Actions"
          }
        >
          <PlayIcon className="size-3.5" />
          {flagged && (
            <span
              aria-hidden
              className={cn(
                "absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background",
                aggregate === "running" ? "bg-[var(--acc-orange)]" : "bg-[var(--acc-red)]",
              )}
            />
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="top-auto bottom-0 max-w-full translate-y-0 rounded-b-none px-3 pt-5 pb-[max(1rem,env(safe-area-inset-bottom))] data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 sm:max-w-full">
        <DialogHeader className={cn("px-1 text-left", details != null && "sr-only")}>
          <DialogTitle>Actions</DialogTitle>
          <DialogDescription>Run in this conversation&apos;s working copy.</DialogDescription>
        </DialogHeader>
        {details != null ? (
          <div className="-mx-3 max-h-[80svh] overflow-y-auto pt-3">{details}</div>
        ) : (
          <ul className="-mx-1 flex max-h-[60svh] flex-col gap-1 overflow-y-auto">
            {actions.map((action) => (
              <li key={action.id}>
                <SheetRow
                  action={action}
                  featureId={featureId}
                  projectId={projectId}
                  onDone={() => onOpenChange(false)}
                  onShowDetails={() => onShowDetails(action.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SheetRow({
  action,
  featureId,
  projectId,
  onDone,
  onShowDetails,
}: {
  action: CustomAction;
  featureId: number;
  projectId: number;
  onDone: () => void;
  onShowDetails: () => void;
}): ReactElement {
  const starting = useIsActionStarting(action, featureId);
  const running = !action.run_in_terminal && runStateOf(action.last_run) === "running";
  const runId = action.last_run?.run_id;
  return (
    <div className="flex min-h-11 items-center gap-2 rounded-md px-1">
      <button
        type="button"
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        onClick={() => {
          if (running) {
            onShowDetails();
            return;
          }
          onDone();
          activateAction(action, featureId, projectId);
        }}
      >
        <CustomActionIcon iconData={action.icon_data} name={action.name} className="size-4" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{action.name}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <RunStateDot run={action.run_in_terminal ? null : action.last_run} />
            {action.run_in_terminal ? "Opens a terminal" : runStateText(action.last_run)}
          </span>
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-11 text-muted-foreground disabled:opacity-100"
        disabled={starting}
        aria-label={running ? `Stop “${action.name}”` : `Run “${action.name}”`}
        onClick={() => {
          if (running && runId != null) {
            void stopCustomActionRun({ action, featureId, projectId }, runId);
            return;
          }
          onDone();
          activateAction(action, featureId, projectId);
        }}
      >
        {starting ? (
          <Loader2Icon className="animate-spin" />
        ) : running ? (
          <SquareIcon className="fill-current" />
        ) : action.run_in_terminal ? (
          <TerminalIcon />
        ) : (
          <PlayIcon />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-11 text-muted-foreground"
        aria-label={`Details of “${action.name}”`}
        onClick={onShowDetails}
      >
        <ChevronRightIcon />
      </Button>
    </div>
  );
}

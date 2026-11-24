import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement, ReactNode } from "react";
import { ChevronRightIcon, Loader2Icon, PlayIcon, SquareIcon, TerminalIcon } from "lucide-react";

import type { CustomAction } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PhoneSheetContent } from "@/components/PhoneSheet";
import { useIsActionStarting } from "@/hooks/useFeatureCustomActions";
import { stopCustomActionRun } from "@/lib/custom-actions/launch";
import { runStateOf, runStateText } from "@/lib/custom-actions/run-state";
import { cn } from "@/lib/utils";
import { CustomActionIcon } from "./CustomActionIcon";
import { RunStateDot } from "./RunStateDot";
import { activateAction } from "./useCustomActionsLauncher";

interface MobileCustomActionsSheetProps {
  actions: readonly CustomAction[];
  featureId: number;
  projectId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowDetails: (actionId: number) => void;
  /** The details page of one action, shown instead of the list. */
  details: ReactNode;
}

/**
 * Phones get a bottom sheet instead of the split button: one 44px row per
 * action to run or stop it and see where it stands, and a page per action
 * with its output, runs and settings. It has no trigger of its own: the
 * header's conversation sheet lists the actions (`CustomActionSheetRow`) and
 * opens this one on an action's details, as do the palette and a finished
 * run's "Show output", through the custom actions store.
 */
export function MobileCustomActionsSheet({
  actions,
  featureId,
  projectId,
  open,
  onOpenChange,
  onShowDetails,
  details,
}: MobileCustomActionsSheetProps): ReactElement {
  const { t } = useUiTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The same sheet as the header's "…", which opens this one. */}
      <PhoneSheetContent
        className="gap-4 px-3 pt-5 pb-[max(1rem,var(--app-inset-bottom))]"
        onCloseAutoFocus={returnFocusToMoreTrigger}
      >
        <DialogHeader className={cn("px-1 text-left", details != null && "sr-only")}>
          <DialogTitle>
            {t("customActions.mobileCustomActionsSheet.actions", "Actions")}
          </DialogTitle>
          <DialogDescription>
            {t("customActions.mobile.help", "Run in this conversation's working copy.")}
          </DialogDescription>
        </DialogHeader>
        {details != null ? (
          <div className="-mx-3 max-h-[80svh] overflow-y-auto pt-3">{details}</div>
        ) : (
          <ul className="-mx-1 flex max-h-[60svh] flex-col gap-1 overflow-y-auto">
            {actions.map((action) => (
              <li key={action.id}>
                <CustomActionSheetRow
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
      </PhoneSheetContent>
    </Dialog>
  );
}

/**
 * This sheet has no trigger of its own (the header's "…" sheet opens it), so
 * Radix would drop focus on <body> when it closes: hand it back to "…".
 */
function returnFocusToMoreTrigger(event: Event): void {
  const trigger = document.querySelector<HTMLElement>("[data-phone-more-trigger]");
  if (!trigger) return;
  event.preventDefault();
  trigger.focus();
}

/** One action: run or stop it, see where it stands, open its details. */
export function CustomActionSheetRow({
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
  const { t } = useUiTranslation();
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
            {action.run_in_terminal
              ? t("customActions.mobile.terminal", "Opens a terminal")
              : runStateText(action.last_run)}
          </span>
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-11 text-muted-foreground disabled:opacity-100"
        disabled={starting}
        aria-label={
          running
            ? t("customActions.stopNamed", "Stop “{{name}}”", { name: action.name })
            : t("customActions.runNamed", "Run “{{name}}”", { name: action.name })
        }
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
        aria-label={t("customActions.detailsNamed", "Details of “{{name}}”", { name: action.name })}
        onClick={onShowDetails}
      >
        <ChevronRightIcon />
      </Button>
    </div>
  );
}

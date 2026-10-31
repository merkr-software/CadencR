import { useEffect, useState, type ReactElement } from "react";
import {
  ChevronDownIcon,
  Loader2Icon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  TerminalIcon,
} from "lucide-react";

import type { CustomAction } from "@/api/generated";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useFeatureCustomActions, useIsActionStarting } from "@/hooks/useFeatureCustomActions";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import type { CustomActionRunState } from "@/lib/custom-actions/run-state";
import { cn } from "@/lib/utils";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";
import { CustomActionDetails } from "./CustomActionDetails";
import { CustomActionsMenu } from "./CustomActionsMenu";
import { DeleteCustomActionDialog } from "./DeleteCustomActionDialog";
import { MobileCustomActionsSheet } from "./MobileCustomActionsSheet";
import { useCustomActionsLauncher } from "./useCustomActionsLauncher";

/** Same chrome as the Git split button beside it. */
const LAUNCHER_BUTTON_CLASS =
  "border-border/80 bg-muted/20 text-xs text-foreground hover:bg-muted/35 disabled:opacity-100 disabled:bg-muted/20 disabled:text-muted-foreground";

const AGGREGATE_LABEL: Record<CustomActionRunState, string | null> = {
  running: "an action is running",
  failed: "an action failed",
  stopped: null,
  succeeded: null,
  idle: null,
};

interface CustomActionsLauncherProps {
  featureId: number;
  projectId: number;
}

/**
 * The header's custom-action control, shaped like the Git button: the
 * primary half runs the selected action (or stops it while it runs), the
 * chevron opens the menu of every action. One mark on the chevron speaks for
 * all of them, and only when something runs or failed. The menu is also
 * where an action's output, runs and settings live (its details page).
 */
export function CustomActionsLauncher({
  featureId,
  projectId,
}: CustomActionsLauncherProps): ReactElement | null {
  const isMobile = useIsMobile();
  const { data: actions = [], isPending } = useFeatureCustomActions(projectId, featureId);
  const menu = useLauncherMenu(featureId, actions);
  const [deleting, setDeleting] = useState<CustomAction | null>(null);
  const launcher = useCustomActionsLauncher({
    actions,
    featureId,
    projectId,
    openMenu: menu.showList,
    bindKeys: !isMobile,
  });

  // Outside the early returns: deleting the last action empties the list
  // while its confirmation still shows.
  const deleteDialog = deleting && (
    <DeleteCustomActionDialog action={deleting} onClose={() => setDeleting(null)} />
  );
  if (isPending) return deleteDialog;
  const detailsProps = menu.details && {
    actions,
    action: menu.details,
    featureId,
    projectId,
    onBack: menu.showList,
    onShowAction: menu.showDetails,
    onLeave: menu.close,
    onDelete: setDeleting,
  };
  if (isMobile) {
    if (actions.length === 0) return deleteDialog;
    return (
      <>
        <MobileCustomActionsSheet
          actions={actions}
          featureId={featureId}
          projectId={projectId}
          aggregate={launcher.aggregate}
          open={menu.open}
          onOpenChange={menu.setOpen}
          onShowDetails={menu.showDetails}
          details={
            detailsProps && <CustomActionDetails {...detailsProps} outputClassName="h-[42svh]" />
          }
        />
        {deleteDialog}
      </>
    );
  }
  if (actions.length === 0) {
    return (
      <>
        <NewActionButton projectId={projectId} />
        {deleteDialog}
      </>
    );
  }
  return (
    <div className="inline-flex items-center">
      {launcher.primary && (
        <PrimaryButton
          action={launcher.primary.action}
          featureId={featureId}
          running={launcher.primary.running}
          onTrigger={launcher.primary.trigger}
        />
      )}
      <Popover open={menu.open} onOpenChange={menu.setOpen}>
        <MenuTrigger aggregate={launcher.aggregate} />
        <PopoverContent
          align="end"
          className={cn("p-0", detailsProps ? "w-[min(40rem,calc(100vw-2rem))]" : "w-96")}
          // Opened from another conversation (a toast's "Show output"), the
          // page mounting under it focuses the composer. A click outside and
          // Esc still close it.
          onFocusOutside={(event) => {
            if (menu.openedBeforeMount) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            // Esc steps back to the list before it closes the menu.
            if (!detailsProps) return;
            event.preventDefault();
            menu.showList();
          }}
        >
          {detailsProps ? (
            <CustomActionDetails {...detailsProps} outputClassName="h-[min(22rem,50vh)]" />
          ) : (
            <CustomActionsMenu
              actions={actions}
              selected={launcher.selected}
              featureId={featureId}
              projectId={projectId}
              onDone={menu.close}
              onShowDetails={menu.showDetails}
            />
          )}
        </PopoverContent>
      </Popover>
      {deleteDialog}
    </div>
  );
}

/** Launchers mounted per conversation, to tell a remount from leaving it. */
const mountedLaunchers = new Map<number, number>();

/**
 * The menu's open state lives in the store, so the shortcuts, the palette
 * and a finished run's "Show output" can open it on an action's details.
 */
function useLauncherMenu(featureId: number, actions: readonly CustomAction[]) {
  const menu = useCustomActionsUiStore((state) =>
    state.menu?.featureId === featureId ? state.menu : null,
  );
  const open = menu != null;
  // Open before this launcher mounted: asked from another conversation.
  const [openedBeforeMount, setOpenedBeforeMount] = useState(open);
  if (openedBeforeMount && !open) setOpenedBeforeMount(false);
  useEffect(() => {
    mountedLaunchers.set(featureId, (mountedLaunchers.get(featureId) ?? 0) + 1);
    return () => {
      mountedLaunchers.set(featureId, (mountedLaunchers.get(featureId) ?? 1) - 1);
      // Leaving the conversation closes its menu, so coming back doesn't
      // reopen it. Deferred, as a StrictMode remount follows at once.
      queueMicrotask(() => {
        if ((mountedLaunchers.get(featureId) ?? 0) > 0) return;
        const store = useCustomActionsUiStore.getState();
        if (store.menu?.featureId === featureId) store.closeMenu();
      });
    };
  }, [featureId]);
  // An action deleted (or no longer offered) while shown falls back to the list.
  const details = actions.find((action) => action.id === menu?.actionId) ?? null;
  const store = useCustomActionsUiStore.getState;
  const showList = (): void => store().openMenu(featureId, null);
  const close = (): void => store().closeMenu();
  return {
    open,
    openedBeforeMount,
    details,
    setOpen: (next: boolean): void => (next ? showList() : close()),
    showList,
    showDetails: (actionId: number): void => store().openMenu(featureId, actionId),
    close,
  };
}

function PrimaryButton({
  action,
  featureId,
  running,
  onTrigger,
}: {
  action: CustomAction;
  featureId: number;
  running: boolean;
  onTrigger: () => void;
}): ReactElement {
  const starting = useIsActionStarting(action, featureId);
  const Icon = starting
    ? Loader2Icon
    : running
      ? SquareIcon
      : action.run_in_terminal
        ? TerminalIcon
        : PlayIcon;
  const verb = running ? "Stop" : action.run_in_terminal ? "Run in terminal:" : "Run";
  return (
    <Button
      variant="outline"
      size="xs"
      className={cn(LAUNCHER_BUTTON_CLASS, "max-w-48 rounded-r-none border-r-0")}
      disabled={starting}
      onClick={onTrigger}
      title={`${verb} “${action.name}”`}
      aria-label={`${verb} “${action.name}”`}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3.5",
          starting && "animate-spin",
          running && "fill-current text-[var(--acc-orange)]",
        )}
      />
      <span className="truncate">{action.name}</span>
    </Button>
  );
}

function MenuTrigger({ aggregate }: { aggregate: CustomActionRunState }): ReactElement {
  const keys = useShortcutKeys("custom-actions");
  const status = AGGREGATE_LABEL[aggregate];
  return (
    <ShortcutTooltip label="Custom actions" keys={keys}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className={cn(LAUNCHER_BUTTON_CLASS, "relative rounded-l-none px-1.5")}
          aria-label={status ? `Custom actions, ${status}` : "Custom actions"}
        >
          <ChevronDownIcon className="size-3.5" />
          {status && (
            <span
              aria-hidden
              className={cn(
                "absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background",
                aggregate === "running"
                  ? "bg-[var(--acc-orange)] motion-safe:animate-pulse"
                  : "bg-[var(--acc-red)]",
              )}
            />
          )}
        </Button>
      </PopoverTrigger>
    </ShortcutTooltip>
  );
}

function NewActionButton({ projectId }: { projectId: number }): ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="text-muted-foreground"
      title="New custom action"
      aria-label="New custom action"
      onClick={() =>
        useCustomActionsUiStore.getState().openEditor({ projectId, defaultScope: "project" })
      }
    >
      <PlusIcon />
    </Button>
  );
}

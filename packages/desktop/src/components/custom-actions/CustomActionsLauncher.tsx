import { useState, type ReactElement } from "react";
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
import { CustomActionsMenu } from "./CustomActionsMenu";
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
 * all of them, and only when something runs or failed.
 */
export function CustomActionsLauncher({
  featureId,
  projectId,
}: CustomActionsLauncherProps): ReactElement | null {
  const isMobile = useIsMobile();
  const { data: actions = [], isPending } = useFeatureCustomActions(projectId, featureId);
  const [menuOpen, setMenuOpen] = useState(false);
  const launcher = useCustomActionsLauncher({
    actions,
    featureId,
    projectId,
    openMenu: () => setMenuOpen(true),
    bindKeys: !isMobile,
  });

  if (isPending) return null;
  if (isMobile) {
    if (actions.length === 0) return null;
    return (
      <MobileCustomActionsSheet
        actions={actions}
        featureId={featureId}
        projectId={projectId}
        aggregate={launcher.aggregate}
        open={menuOpen}
        onOpenChange={setMenuOpen}
      />
    );
  }
  if (actions.length === 0) return <NewActionButton projectId={projectId} />;
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
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger aggregate={launcher.aggregate} />
        <PopoverContent align="end" className="w-96 p-0">
          <CustomActionsMenu
            actions={actions}
            selected={launcher.selected}
            featureId={featureId}
            projectId={projectId}
            onDone={() => setMenuOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
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

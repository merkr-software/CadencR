import { ChevronUp, ListPlus, Timer } from "lucide-react";
import { ResolvedShortcutHint } from "@/components/KbdShortcut";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface AutoMessageMenuProps {
  /** Queue the draft for after the agent's turn (only while it works). */
  onQueue?: () => void;
  /** Opens the conversation's schedule editor with the current prompt text. */
  requestSchedule?: () => void;
  /** True when there is no schedulable text yet. */
  scheduleDisabled?: boolean;
  /** Disables the trigger (nothing in the menu applies right now). */
  disabled: boolean;
  /** Overrides the trigger styling so it can sit in the Send split-button group. */
  className?: string;
}

/**
 * The chevron next to Send that opens a menu of "automatic" message kinds. The
 * editor it opens is owned by the composer (a schedule belongs to the
 * conversation, not to this button), so this stays a pure menu.
 */
export function AutoMessageMenu({
  requestSchedule,
  scheduleDisabled = false,
  disabled,
  className,
  onQueue,
}: AutoMessageMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Message send options"
          data-composer-action-compact
          disabled={disabled}
          className={cn(
            "flex h-(--composer-instrument-size) w-(--composer-instrument-size) shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 data-[state=open]:bg-muted data-[state=open]:text-foreground",
            className,
          )}
        >
          <ChevronUp className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="min-w-44">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Send options
        </DropdownMenuLabel>
        {onQueue && (
          <DropdownMenuItem onSelect={onQueue} disabled={disabled}>
            <ListPlus />
            Queue after this turn
            <span className="ml-auto">
              <ResolvedShortcutHint shortcutId="agent-send" />
            </span>
          </DropdownMenuItem>
        )}
        {requestSchedule && (
          <DropdownMenuItem onSelect={requestSchedule} disabled={scheduleDisabled}>
            <Timer />
            Schedule for later…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

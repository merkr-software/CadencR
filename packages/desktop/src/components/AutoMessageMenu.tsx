import { useCallback, useState } from "react";
import { ChevronUp, Timer } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ScheduleMessageDialog } from "./agent-session/ScheduleMessageDialog";

export interface AutoMessageMenuProps {
  /** Snapshot the current (trimmed) prompt text when an action opens. */
  getText: () => string;
  /** Persist the schedule. Rejects on failure (dialog stays open). */
  onSchedule: (text: string, scheduledAt: Date) => Promise<void>;
  /** Called after a successful schedule so the bar can clear its input. */
  onScheduled: () => void;
  /** True when there is no schedulable text yet — disables the trigger. */
  disabled: boolean;
  /** Overrides the trigger styling so it can sit in the Send split-button group. */
  className?: string;
}

/**
 * The chevron next to Send that opens a menu of "automatic" message kinds. Today
 * the only kind is "Schedule for later"; the menu exists so future kinds (e.g.
 * recurring or condition-triggered sends) slot in without re-touching the prompt
 * bar. Self-contained so the prompt bar stays under its line-count budget.
 */
export function AutoMessageMenu({
  getText,
  onSchedule,
  onScheduled,
  disabled,
  className,
}: AutoMessageMenuProps) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState("");

  const openScheduleDialog = useCallback(() => {
    const text = getText();
    if (!text) return;
    setSnapshot(text);
    setOpen(true);
  }, [getText]);

  const handleSubmit = useCallback(
    async (text: string, scheduledAt: Date): Promise<void> => {
      await onSchedule(text, scheduledAt);
      onScheduled();
    },
    [onSchedule, onScheduled],
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Message send options"
            disabled={disabled}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 data-[state=open]:bg-muted data-[state=open]:text-foreground",
              className,
            )}
          >
            <ChevronUp className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="min-w-44">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Send options
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={openScheduleDialog} disabled={disabled}>
            <Timer />
            Schedule for later
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ScheduleMessageDialog
        open={open}
        onOpenChange={setOpen}
        mode="create"
        initialText={snapshot}
        initialDate={null}
        onSubmit={handleSubmit}
      />
    </>
  );
}

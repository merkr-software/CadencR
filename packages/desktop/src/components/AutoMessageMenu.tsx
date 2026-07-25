import { ChevronUp, Timer } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface AutoMessageMenuProps {
  /** Opens the conversation's schedule editor with the current prompt text. */
  requestSchedule: () => void;
  /** True when there is no schedulable text yet — disables the trigger. */
  disabled: boolean;
  /** Overrides the trigger styling so it can sit in the Send split-button group. */
  className?: string;
}

/**
 * The chevron next to Send that opens a menu of "automatic" message kinds. The
 * editor it opens is owned by the composer (a schedule belongs to the
 * conversation, not to this button), so this stays a pure menu.
 */
export function AutoMessageMenu({ requestSchedule, disabled, className }: AutoMessageMenuProps) {
  return (
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
        <DropdownMenuItem onSelect={requestSchedule} disabled={disabled}>
          <Timer />
          Schedule for later…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

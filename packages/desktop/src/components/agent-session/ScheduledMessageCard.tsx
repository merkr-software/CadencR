import { memo, useEffect, useMemo, useReducer } from "react";
import { CalendarClock, Loader2, Pencil, Send, X } from "lucide-react";
import type { ScheduledMessage } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { ShortcutTooltip } from "../ShortcutTooltip";
import {
  formatScheduledAbsolute,
  formatScheduledRelative,
  nextCountdownDelay,
} from "@/lib/scheduled-time";

/**
 * Re-render the countdown on a cadence that tightens as the deadline nears (see
 * `nextCountdownDelay`). Re-evaluated each tick, so it accelerates to 1s inside
 * the final minute and stops once the target has passed — never an unbounded
 * per-second render.
 */
function useCountdownTick(target: Date): void {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const delay = nextCountdownDelay(target.getTime() - Date.now());
      if (delay == null) return;
      timer = setTimeout(() => {
        tick();
        schedule();
      }, delay);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [target]);
}

export interface ScheduledMessageCardProps {
  scheduled: ScheduledMessage;
  onEdit: () => void;
  onSendNow: () => void;
  onCancel: () => void;
  busy: boolean;
}

/**
 * Pending scheduled-message banner shown above the meta chips. Editable and
 * cancellable until the scheduler fires.
 */
export const ScheduledMessageCard = memo(function ScheduledMessageCard({
  scheduled,
  onEdit,
  onSendNow,
  onCancel,
  busy,
}: ScheduledMessageCardProps) {
  const date = useMemo(() => new Date(scheduled.scheduled_at), [scheduled.scheduled_at]);
  useCountdownTick(date);

  return (
    <div className="px-3 pt-2">
      <div className="flex items-center gap-2.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
        <CalendarClock className="size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 text-xs">
            <span className="font-medium text-foreground">
              Scheduled {formatScheduledRelative(date)}
            </span>
            <span className="text-muted-foreground">· {formatScheduledAbsolute(date)}</span>
          </div>
          <p className="truncate text-xs text-muted-foreground" title={scheduled.text}>
            {scheduled.text}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {busy && <Loader2 className="mr-1 size-3.5 animate-spin text-muted-foreground" />}
          <ShortcutTooltip label="Edit">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onEdit}
              disabled={busy}
              aria-label="Edit scheduled message"
            >
              <Pencil className="size-3.5" />
            </Button>
          </ShortcutTooltip>
          <ShortcutTooltip label="Send now">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onSendNow}
              disabled={busy}
              aria-label="Send scheduled message now"
            >
              <Send className="size-3.5" />
            </Button>
          </ShortcutTooltip>
          <ShortcutTooltip label="Cancel">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-destructive"
              onClick={onCancel}
              disabled={busy}
              aria-label="Cancel scheduled message"
            >
              <X className="size-3.5" />
            </Button>
          </ShortcutTooltip>
        </div>
      </div>
    </div>
  );
});

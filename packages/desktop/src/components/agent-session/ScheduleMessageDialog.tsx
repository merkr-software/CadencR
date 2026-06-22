import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SCHEDULE_PRESETS, localTimeZone } from "@/lib/scheduled-time";
import { DateTimePicker } from "./DateTimePicker";

const ONE_HOUR_MS = 60 * 60_000;

export interface ScheduleMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  /** Prefilled message text. Editable in `edit` mode, shown read-only in `create`. */
  initialText: string;
  initialDate: Date | null;
  /** Persist the schedule. Rejects on failure (dialog stays open). */
  onSubmit: (text: string, scheduledAt: Date) => Promise<void>;
  /** Cancel an existing schedule (edit mode only). */
  onDelete?: () => Promise<void>;
}

export function ScheduleMessageDialog({
  open,
  onOpenChange,
  mode,
  initialText,
  initialDate,
  onSubmit,
  onDelete,
}: ScheduleMessageDialogProps) {
  const [text, setText] = useState(initialText);
  const [date, setDate] = useState<Date>(() => initialDate ?? new Date(Date.now() + ONE_HOUR_MS));
  const [busy, setBusy] = useState(false);
  // Captured once per open so `min` and validation don't drift as the dialog
  // sits open.
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!open) return;
    const opened = new Date();
    setNow(opened);
    setText(initialText);
    setDate(initialDate ?? new Date(opened.getTime() + ONE_HOUR_MS));
    setBusy(false);
  }, [open, initialText, initialDate]);

  const isPast = date.getTime() <= now.getTime();
  const canSubmit = !isPast && text.trim().length > 0 && !busy;
  const isEdit = mode === "edit";

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit(text.trim(), date);
      onOpenChange(false);
    } catch {
      // useScheduledMessage surfaces the toast; keep the dialog open to retry.
      setBusy(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!onDelete) return;
    setBusy(true);
    try {
      await onDelete();
      onOpenChange(false);
    } catch {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit scheduled message" : "Schedule message"}</DialogTitle>
          <DialogDescription>
            The message is sent automatically at the time you pick, as long as Cadencr is running.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {isEdit ? (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Message</label>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                className="max-h-40 resize-none"
                autoFocus
              />
            </div>
          ) : (
            <div className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              {text}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {SCHEDULE_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-full px-3 text-xs"
                  onClick={() => setDate(preset.resolve(new Date()))}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <DateTimePicker value={date} onChange={setDate} min={now} invalid={isPast} />
            <p className="text-xs text-muted-foreground">
              {isPast ? (
                <span className="text-destructive">Pick a time in the future.</span>
              ) : (
                <>Times shown in your timezone ({localTimeZone()}).</>
              )}
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {isEdit && onDelete ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              disabled={busy}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              Cancel send
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {isEdit ? "Save" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

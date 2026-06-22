import { useCallback, useState } from "react";
import type { UseScheduledMessageResult } from "@/hooks/useScheduledMessage";
import { ScheduledMessageCard } from "./ScheduledMessageCard";
import { ScheduleMessageDialog } from "./ScheduleMessageDialog";

interface SessionScheduledCardProps {
  schedule: UseScheduledMessageResult;
  /** Dispatch a message immediately (used by the card's "send now"). */
  onSend: (message: string) => void | Promise<void>;
}

/**
 * Renders the pending scheduled-message banner above the meta chips, plus the
 * edit dialog. Owns only the dialog's open state; all data flows through the
 * shared `useScheduledMessage` hook so the composer and prompt bar stay in
 * sync.
 */
export function SessionScheduledCard({ schedule, onSend }: SessionScheduledCardProps) {
  const [editOpen, setEditOpen] = useState(false);
  const { scheduled } = schedule;

  const handleSendNow = useCallback(async () => {
    if (!scheduled) return;
    const text = scheduled.text;
    await schedule.cancel();
    await onSend(text);
  }, [onSend, schedule, scheduled]);

  if (!scheduled) return null;

  return (
    <>
      <ScheduledMessageCard
        scheduled={scheduled}
        onEdit={() => setEditOpen(true)}
        onSendNow={() => void handleSendNow()}
        onCancel={() => void schedule.cancel()}
        busy={schedule.isMutating}
      />
      <ScheduleMessageDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        mode="edit"
        initialText={scheduled.text}
        initialDate={new Date(scheduled.scheduled_at)}
        onSubmit={schedule.schedule}
        onDelete={schedule.cancel}
      />
    </>
  );
}

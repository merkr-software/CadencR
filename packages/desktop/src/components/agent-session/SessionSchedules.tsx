import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useListProjects, type Schedule } from "@/api/generated";
import { ScheduleEditorDialog } from "@/components/schedules/ScheduleEditorDialog";
import { fireAndForget, useSchedules } from "@/hooks/useSchedules";
import { isActive } from "@/lib/schedules/status";
import { SessionSchedulesBanner } from "./SessionSchedulesBanner";

export interface SessionSchedulesController {
  /** Armed schedules for this conversation, soonest first. */
  armed: Schedule[];
  /** Opens the editor prefilled with the composer's text. `onSaved` runs once
   *  the schedule is persisted, so the composer can clear itself. */
  requestSchedule: (prompt: string, onSaved: () => void) => void;
  /** The banner + editor dialog. Rendered above the composer's meta bar. */
  element: ReactElement | null;
}

/**
 * Owns everything schedule-related for one conversation's composer: the banner,
 * the editor dialog, and the "schedule this message" entry point the prompt bar
 * triggers.
 *
 * Kept out of `AgentSessionComposer` so that file stays within its line budget,
 * and so the composer only has to know about one object.
 */
export function useSessionSchedules(
  featureId: number | undefined,
  projectId: number | undefined,
): SessionSchedulesController {
  const projectsQuery = useListProjects();
  const { schedules, save, remove, runNow, isMutating } = useSchedules(
    featureId ? { feature_id: featureId } : {},
  );
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [draftPrompt, setDraftPrompt] = useState("");
  // Cleared after a successful save so a later edit can't re-clear the composer.
  const [onSaved, setOnSaved] = useState<(() => void) | null>(null);

  const armed = useMemo(() => schedules.filter(isActive), [schedules]);
  const lockedConversation = useMemo(
    () => (featureId ? { featureId, projectId } : undefined),
    [featureId, projectId],
  );

  const requestSchedule = useCallback((prompt: string, saved: () => void): void => {
    setEditing(null);
    setDraftPrompt(prompt);
    // `setState` treats a bare function as an updater, so the callback is
    // wrapped rather than invoked.
    setOnSaved(() => saved);
    setOpen(true);
  }, []);

  const editSchedule = useCallback((schedule: Schedule): void => {
    setEditing(schedule);
    setDraftPrompt("");
    setOnSaved(null);
    setOpen(true);
  }, []);

  const handleSave = useCallback(
    async (body: Parameters<typeof save>[0], id?: number) => {
      const saved = await save(body, id);
      onSaved?.();
      setOnSaved(null);
      return saved;
    },
    [onSaved, save],
  );

  const cancel = useCallback((schedule: Schedule) => fireAndForget(remove(schedule.id)), [remove]);
  const sendNow = useCallback((schedule: Schedule) => fireAndForget(runNow(schedule.id)), [runNow]);

  const element = featureId ? (
    <>
      <SessionSchedulesBanner
        schedules={armed}
        busy={isMutating}
        onEdit={editSchedule}
        onCancel={cancel}
        onSendNow={sendNow}
      />
      <ScheduleEditorDialog
        open={open}
        onOpenChange={setOpen}
        schedule={editing}
        initialPrompt={draftPrompt}
        lockedConversation={lockedConversation}
        projects={projectsQuery.data ?? []}
        onSave={handleSave}
        onDelete={remove}
      />
    </>
  ) : null;

  return useMemo(() => ({ armed, requestSchedule, element }), [armed, requestSchedule, element]);
}

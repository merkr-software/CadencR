import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project, SaveScheduleRequest, Schedule, ScheduleTarget } from "@/api/generated";
import {
  draftError,
  draftToInput,
  emptyDraft,
  toDraft,
  type RecurrenceDraft,
} from "@/lib/schedules/recurrence";

export interface ScheduleDraftParams {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule?: Schedule | null;
  initialPrompt?: string;
  /** Set when the editor is opened from a conversation's own composer. The
   *  project rides along because the chips need it: it is what resolves the
   *  command catalog and the conversation's current settings. */
  lockedConversation?: { featureId: number; projectId?: number };
  projects: Project[];
  onSave: (body: SaveScheduleRequest, id?: number) => Promise<unknown>;
  onDelete?: (id: number) => Promise<void>;
}

export interface ScheduleDraft {
  name: string;
  setName: (name: string) => void;
  prompt: string;
  setPrompt: (prompt: string) => void;
  target: ScheduleTarget;
  setTarget: (target: ScheduleTarget) => void;
  recurrence: RecurrenceDraft;
  setRecurrence: (recurrence: RecurrenceDraft) => void;
  /** Captured once per open so `min` and validation don't drift while the
   *  dialog sits open. */
  now: Date;
  /** Changes whenever a different schedule is loaded — remounts the prompt
   *  editor, which is uncontrolled once mounted. */
  formKey: number;
  busy: boolean;
  worktreeError: string | null;
  canSave: boolean;
  save: () => Promise<void>;
  remove: () => Promise<void>;
}

function initialTarget(
  schedule: Schedule | null | undefined,
  lockedConversation: ScheduleDraftParams["lockedConversation"],
  projects: Project[],
): ScheduleTarget {
  if (schedule) {
    // A stored conversation target has no project (the backend strips it), but
    // the picker browses by project — recover it from the resolved context.
    return {
      ...schedule.target,
      project_id: schedule.target.project_id ?? schedule.context.project_id,
    };
  }
  if (lockedConversation) {
    return {
      kind: "conversation",
      feature_id: lockedConversation.featureId,
      project_id: lockedConversation.projectId,
    };
  }
  return { kind: "new_conversation", project_id: projects[0]?.id, worktree_mode: "skip" };
}

/** The editable fields, plus the one-shot load of a schedule into them. */
function useDraftFields() {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [target, setTarget] = useState<ScheduleTarget>({ kind: "new_conversation" });
  const [recurrence, setRecurrence] = useState<RecurrenceDraft>(() => emptyDraft());
  const [now, setNow] = useState(() => new Date());
  const [formKey, setFormKey] = useState(0);

  const load = useCallback(
    (
      schedule: Schedule | null | undefined,
      initialPrompt: string | undefined,
      lockedConversation: ScheduleDraftParams["lockedConversation"],
      projects: Project[],
    ): void => {
      const opened = new Date();
      setNow(opened);
      setName(schedule?.name ?? "");
      setPrompt(schedule?.prompt ?? initialPrompt ?? "");
      setTarget(initialTarget(schedule, lockedConversation, projects));
      setRecurrence(
        schedule ? toDraft(schedule.recurrence, schedule.next_run_at, opened) : emptyDraft(opened),
      );
      // Bumped in the same commit as `setPrompt`, so the editor mounts with the
      // text already in state.
      setFormKey((key) => key + 1);
    },
    [],
  );

  // A hook that returns a fresh literal breaks every downstream `useMemo` and
  // `React.memo` (`frontend-performance.md`), and this one feeds the whole
  // editor dialog. The identity is still per-keystroke — `name` and `prompt`
  // are deps — but it holds across the renders those fields didn't cause.
  return useMemo(
    () => ({
      name,
      setName,
      prompt,
      setPrompt,
      target,
      setTarget,
      recurrence,
      setRecurrence,
      now,
      formKey,
      load,
    }),
    [formKey, load, name, now, prompt, recurrence, target],
  );
}

/** Form state and validation for {@link ScheduleEditorDialog}. */
export function useScheduleDraft({
  open,
  onOpenChange,
  schedule,
  initialPrompt,
  lockedConversation,
  projects,
  onSave,
  onDelete,
}: ScheduleDraftParams): ScheduleDraft {
  const fields = useDraftFields();
  const { name, prompt, target, setTarget, recurrence, load } = fields;
  const [busy, setBusy] = useState(false);

  // Read inside the effect instead of listed as deps: callers build
  // `lockedConversation` and `projects` inline, so those identities change on
  // every parent render. Depending on them re-ran this reset mid-edit — wiping
  // what had been typed and remounting the prompt editor — whenever the
  // conversation behind the dialog re-rendered, which during streaming is
  // constantly.
  const latest = useRef({ schedule, initialPrompt, lockedConversation, projects });
  latest.current = { schedule, initialPrompt, lockedConversation, projects };

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    const { schedule, initialPrompt, lockedConversation, projects } = latest.current;
    load(schedule, initialPrompt, lockedConversation, projects);
    // A different schedule (or none) is a different form; anything else that
    // changes while the dialog sits open is the caller re-rendering, not a new
    // form to load.
  }, [open, schedule?.id, initialPrompt, load]);

  // The project list can still be loading when the dialog opens, which would
  // leave a new-conversation draft with no project. Fill it in once, without
  // ever overwriting a choice the user has made.
  const firstProjectId = projects[0]?.id;
  useEffect(() => {
    if (!open || firstProjectId == null) return;
    setTarget((current) =>
      current.kind === "new_conversation" && current.project_id == null
        ? { ...current, project_id: firstProjectId }
        : current,
    );
  }, [open, firstProjectId, setTarget]);

  const { worktreeError, canSave } = validate(fields, busy);

  const save = useCallback(async (): Promise<void> => {
    if (!canSave) return;
    setBusy(true);
    try {
      await onSave(
        {
          name: name.trim() || undefined,
          prompt: prompt.trim(),
          target,
          recurrence: draftToInput(recurrence),
          enabled: schedule?.enabled ?? true,
        },
        schedule?.id,
      );
      onOpenChange(false);
    } catch {
      // useSchedules surfaces the toast; keep the dialog open to retry.
      setBusy(false);
    }
  }, [canSave, name, onOpenChange, onSave, prompt, recurrence, schedule, target]);

  const remove = useCallback(async (): Promise<void> => {
    if (!schedule || !onDelete) return;
    setBusy(true);
    try {
      await onDelete(schedule.id);
      onOpenChange(false);
    } catch {
      setBusy(false);
    }
  }, [onDelete, onOpenChange, schedule]);

  return useMemo(
    () => ({ ...fields, busy, worktreeError, canSave, save, remove }),
    [busy, canSave, fields, remove, save, worktreeError],
  );
}

/** What stops a save, in the order the user can act on it. */
function validate(
  { target, prompt, recurrence, now }: ReturnType<typeof useDraftFields>,
  busy: boolean,
): { worktreeError: string | null; canSave: boolean } {
  const missingTarget =
    target.kind === "new_conversation" ? !target.project_id : !target.feature_id;
  // The backend rejects a reuse target with no branch; say so before the save
  // round-trip rather than after it.
  const worktreeError =
    target.worktree_mode === "reuse" && !target.reuse_branch?.trim()
      ? "Pick the branch whose worktree the run should use."
      : null;
  const canSave =
    !busy &&
    !draftError(recurrence, now) &&
    !worktreeError &&
    !missingTarget &&
    prompt.trim().length > 0;
  return { worktreeError, canSave };
}

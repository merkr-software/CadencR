/**
 * Builds the optional "schedule send" control for `AgentPromptBar`.
 *
 * Kept out of the bar so that file stays within its line-count budget. The hook
 * is always called (the clear-on-success callback is stable); it returns
 * `undefined` when scheduling isn't available (no handler, or no feature to
 * schedule against). Scheduling is keyed on the feature, so it is available even
 * before the conversation has spawned a session.
 */
import { useCallback, useMemo, type MutableRefObject, type RefObject } from "react";
import type { PromptBarScheduleControl } from "@/components/PromptBarActions";
import type { PromptEditorHandle } from "@/components/prompt-editor/PromptEditor";

interface UsePromptScheduleControlParams {
  onSchedule?: (text: string, scheduledAt: Date) => Promise<void>;
  featureId?: number;
  /** Whether there is schedulable text right now (drives the disabled state). */
  enabled: boolean;
  textRef: MutableRefObject<string>;
  editorRef: RefObject<PromptEditorHandle | null>;
  setText: (text: string) => void;
  saveDraft: (text: string | null) => void;
  addHistoryEntry: (text: string) => void;
  interactedRef: MutableRefObject<boolean>;
}

export function usePromptScheduleControl({
  onSchedule,
  featureId,
  enabled,
  textRef,
  editorRef,
  setText,
  saveDraft,
  addHistoryEntry,
  interactedRef,
}: UsePromptScheduleControlParams): PromptBarScheduleControl | undefined {
  // Mirrors send success: clear the composer once the message is scheduled.
  const onScheduled = useCallback(() => {
    const trimmed = textRef.current.trim();
    setText("");
    editorRef.current?.clear();
    saveDraft(null);
    if (trimmed) addHistoryEntry(trimmed);
    interactedRef.current = true;
  }, [addHistoryEntry, editorRef, interactedRef, saveDraft, setText, textRef]);

  const getText = useCallback(() => textRef.current.trim(), [textRef]);

  // Stable object so the prompt-bar action group can stay memoized.
  return useMemo(() => {
    if (!onSchedule || !featureId) return undefined;
    return { getText, onSchedule, onScheduled, disabled: !enabled };
  }, [enabled, featureId, getText, onSchedule, onScheduled]);
}

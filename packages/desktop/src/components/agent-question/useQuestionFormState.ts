import { useState, useMemo, useCallback, type Dispatch, type SetStateAction } from "react";
import {
  EMPTY_QUESTION_DRAFT,
  useQuestionDraftStore,
  updateQuestionDraft,
  type QuestionDraft,
  type QuestionAnswerDraft,
  type QuestionDraftIdentity,
} from "@/stores/question-drafts";

function useDraftState(identity?: QuestionDraftIdentity) {
  const [localDraft, setLocalDraft] = useState(EMPTY_QUESTION_DRAFT);
  const storedDraft = useQuestionDraftStore((s) => {
    const entry = identity ? s.drafts.get(identity.sessionId) : undefined;
    return entry?.requestId === identity?.requestId ? entry?.draft : undefined;
  });
  const sessionId = identity?.sessionId;
  const requestId = identity?.requestId;
  const updateDraft = useCallback(
    (update: (draft: QuestionDraft) => QuestionDraft) => {
      if (sessionId != null && requestId) updateQuestionDraft({ sessionId, requestId }, update);
      else setLocalDraft(update);
    },
    [sessionId, requestId],
  );
  const draft = identity ? (storedDraft ?? EMPTY_QUESTION_DRAFT) : localDraft;
  return useMemo(() => [draft, updateDraft] as const, [draft, updateDraft]);
}

export function useQuestionFormState(identity?: QuestionDraftIdentity) {
  const [draft, updateDraft] = useDraftState(identity);
  const [freeTextFocused, setFreeTextFocused] = useState(false);
  const setters = useMemo(() => {
    const field =
      <K extends keyof QuestionDraft>(key: K): Dispatch<SetStateAction<QuestionDraft[K]>> =>
      (value) =>
        updateDraft((previous) => {
          const next = typeof value === "function" ? value(previous[key]) : value;
          return Object.is(next, previous[key]) ? previous : { ...previous, [key]: next };
        });
    return {
      setSelectedOptions: field("selectedOptions"),
      setFreeText: field("freeText"),
      setShowOther: field("showOther"),
    };
  }, [updateDraft]);
  const moveTo = useCallback(
    (currentIndex: number, answers: QuestionAnswerDraft[]) => {
      const saved = answers[currentIndex];
      updateDraft(() => ({
        currentIndex,
        answers,
        selectedOptions: new Set(saved?.selectedOptions),
        freeText: saved?.freeText ?? "",
        showOther: saved?.showOther ?? false,
      }));
      setFreeTextFocused(false);
    },
    [updateDraft],
  );
  return useMemo(
    () => ({
      ...draft,
      ...setters,
      freeTextFocused,
      setFreeTextFocused,
      moveTo,
    }),
    [draft, setters, freeTextFocused, moveTo],
  );
}

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useQuestionFormState } from "./useQuestionFormState";
import type {
  QuestionAnswerDraft as SavedAnswer,
  QuestionDraftIdentity,
} from "@/stores/question-drafts";
import {
  agentQuestionOptionValue,
  type AgentQuestion,
  type AgentQuestionAnswers,
} from "@/types/agent-question";

interface UseAgentQuestionFormParams {
  questions: AgentQuestion[];
  draftIdentity?: QuestionDraftIdentity;
  onSubmit: (response: AgentQuestionAnswers) => void;
}

export interface AgentQuestionForm {
  currentIndex: number;
  currentQuestion: AgentQuestion | undefined;
  selectedOptions: Set<string>;
  freeText: string;
  setFreeText: (value: string) => void;
  showOther: boolean;
  showFreeText: boolean;
  freeTextFocused: boolean;
  setFreeTextFocused: (value: boolean) => void;
  highlightedIndex: number | null;
  canGoBack: boolean;
  canGoForward: boolean;
  otherShortcutIndex: number;
  handleBack: () => void;
  handleForward: () => void;
  handleOptionToggle: (option: string) => void;
  handleOtherToggle?: () => void;
  handleNext: () => void;
  /** Answers the current question with exactly this option, and moves on or submits. */
  handleChoose: (option: string) => void;
  handleFreeTextSubmit: () => void;
  flashHighlight: (index: number) => void;
  hasAnswer: boolean;
  isLastQuestion: boolean;
  hasOptions: boolean;
  selectedPreview: string | undefined;
}

function showsFreeText(question: AgentQuestion, otherSelected: boolean): boolean {
  return question.allowCustomAnswer !== false && (otherSelected || !question.options?.length);
}

function answerValues(
  question: AgentQuestion | undefined,
  state: SavedAnswer | undefined,
): string[] {
  if (!question || !state) return [];
  // A restored draft can contain IDs the provider no longer offers.
  if (question.allowCustomAnswer === false) {
    const allowed = new Set(question.options?.map(agentQuestionOptionValue));
    const selected = Array.from(state.selectedOptions).filter((id) => allowed.has(id));
    return !question.multiSelect && selected.length > 1 ? [] : selected;
  }
  const values = question.options?.length ? Array.from(state.selectedOptions) : [];
  const text = state.freeText.trim();
  if (showsFreeText(question, state.showOther) && text) values.push(text);
  return values;
}

type QuestionFormState = ReturnType<typeof useQuestionFormState>;

function currentSavedAnswer({
  selectedOptions,
  freeText,
  showOther,
}: QuestionFormState): SavedAnswer {
  return { selectedOptions, freeText, showOther };
}

function useQuestionNavigation(state: QuestionFormState) {
  const canGoBack = state.currentIndex > 0;
  const canGoForward =
    state.currentIndex < state.answers.length - 1 && state.answers[state.currentIndex + 1] != null;
  const move = useCallback(
    (nextIndex: number): void => {
      const answers = [...state.answers];
      answers[state.currentIndex] = currentSavedAnswer(state);
      state.moveTo(nextIndex, answers);
    },
    [state],
  );
  const handleBack = useCallback(() => {
    if (canGoBack) move(state.currentIndex - 1);
  }, [canGoBack, move, state.currentIndex]);
  const handleForward = useCallback(() => {
    if (canGoForward) move(state.currentIndex + 1);
  }, [canGoForward, move, state.currentIndex]);
  return useMemo(
    () => ({ canGoBack, canGoForward, handleBack, handleForward }),
    [canGoBack, canGoForward, handleBack, handleForward],
  );
}

function useQuestionSubmission(
  questions: AgentQuestion[],
  onSubmit: (response: AgentQuestionAnswers) => void,
  state: QuestionFormState,
) {
  const advance = useCallback(
    (current: SavedAnswer) => {
      const newAnswers = [...state.answers];
      newAnswers[state.currentIndex] = current;
      if (state.currentIndex < questions.length - 1) {
        if (!answerValues(questions[state.currentIndex], current).length) return;
        state.moveTo(state.currentIndex + 1, newAnswers);
        return;
      }
      const values = questions.map((question, index) => answerValues(question, newAnswers[index]));
      const missing = values.findIndex((answer) => !answer.length);
      if (missing === -1) onSubmit(values);
      else if (missing !== state.currentIndex) state.moveTo(missing, newAnswers);
    },
    [onSubmit, questions, state],
  );
  const handleNext = useCallback(() => advance(currentSavedAnswer(state)), [advance, state]);
  const handleChoose = useCallback(
    (option: string) => {
      advance({
        selectedOptions: new Set([option]),
        freeText: "",
        showOther: false,
      });
    },
    [advance],
  );
  const handleFreeTextSubmit = useCallback(() => {
    if (state.freeText.trim()) handleNext();
  }, [handleNext, state.freeText]);
  return useMemo(
    () => ({ handleChoose, handleFreeTextSubmit, handleNext }),
    [handleChoose, handleFreeTextSubmit, handleNext],
  );
}

function useQuestionOptions(question: AgentQuestion | undefined, state: QuestionFormState) {
  const handleOptionToggle = useCallback(
    (option: string) => {
      if (!question) return;
      if (question.multiSelect) {
        state.setSelectedOptions((previous) => {
          const next = new Set(previous);
          if (next.has(option)) next.delete(option);
          else next.add(option);
          return next;
        });
      } else {
        state.setSelectedOptions(new Set([option]));
        state.setShowOther(false);
        state.setFreeText("");
      }
    },
    [question, state],
  );
  const handleOtherToggle = useCallback(() => {
    state.setShowOther((previous) => !previous);
    if (!state.showOther && !question?.multiSelect) state.setSelectedOptions(new Set());
  }, [question?.multiSelect, state]);
  return useMemo(
    () => ({
      handleOptionToggle,
      handleOtherToggle: question?.allowCustomAnswer === false ? undefined : handleOtherToggle,
    }),
    [question?.allowCustomAnswer, handleOptionToggle, handleOtherToggle],
  );
}

function useQuestionHighlight() {
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  const flashHighlight = useCallback((index: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setHighlightedIndex(index);
    timerRef.current = setTimeout(() => setHighlightedIndex(null), 300);
  }, []);
  return useMemo(() => ({ flashHighlight, highlightedIndex }), [flashHighlight, highlightedIndex]);
}

export function useAgentQuestionForm({
  questions,
  onSubmit,
  draftIdentity,
}: UseAgentQuestionFormParams): AgentQuestionForm {
  const state = useQuestionFormState(draftIdentity);
  const currentQuestion = questions[state.currentIndex];
  const navigation = useQuestionNavigation(state);
  const submission = useQuestionSubmission(questions, onSubmit, state);
  const options = useQuestionOptions(currentQuestion, state);
  const highlight = useQuestionHighlight();
  const hasOptions = !!currentQuestion?.options?.length;
  const showFreeText = !!currentQuestion && showsFreeText(currentQuestion, state.showOther);
  const hasAnswer = useMemo(
    () => answerValues(currentQuestion, state).length > 0,
    [currentQuestion, state],
  );
  const selectedPreview = currentQuestion?.options?.findLast(
    (option) => option.preview && state.selectedOptions.has(agentQuestionOptionValue(option)),
  )?.preview;
  return {
    currentIndex: state.currentIndex,
    currentQuestion,
    selectedOptions: state.selectedOptions,
    freeText: state.freeText,
    setFreeText: state.setFreeText,
    showOther: showFreeText && state.showOther,
    showFreeText,
    freeTextFocused: state.freeTextFocused,
    setFreeTextFocused: state.setFreeTextFocused,
    highlightedIndex: highlight.highlightedIndex,
    ...navigation,
    otherShortcutIndex: currentQuestion?.options?.length ?? 0,
    ...options,
    ...submission,
    flashHighlight: highlight.flashHighlight,
    hasAnswer,
    isLastQuestion: state.currentIndex >= questions.length - 1,
    hasOptions,
    selectedPreview,
  };
}

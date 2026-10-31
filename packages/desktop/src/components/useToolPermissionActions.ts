import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PermissionDecisionValue, PermissionOption } from "@/types/agent-permission";

interface ToolPermissionActionsArgs {
  isSubmitting: boolean;
  options: PermissionOption[];
  onDecision: (decision: PermissionDecisionValue, feedback?: string, optionId?: string) => void;
}

interface ToolPermissionActions {
  feedback: string;
  showFeedback: boolean;
  highlightedIndex: number | null;
  submittedIndex: number | null;
  setFeedback: (feedback: string) => void;
  handleOption: (index: number) => void;
  handleDenyWithEnter: () => void;
  handleHotkey: (index: number) => void;
}

export function useToolPermissionActions({
  isSubmitting,
  options,
  onDecision,
}: ToolPermissionActionsArgs): ToolPermissionActions {
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const [submittedIndex, setSubmittedIndex] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    },
    [],
  );
  useEffect(() => {
    if (!isSubmitting) setSubmittedIndex(null);
  }, [isSubmitting]);

  const submitOption = useCallback(
    (option: PermissionOption, index: number) => {
      setSubmittedIndex(index);
      const trimmedFeedback = feedback.trim() || undefined;
      if (option.decision === "deny") {
        if (option.optionId) onDecision("deny", trimmedFeedback, option.optionId);
        else onDecision("deny", trimmedFeedback);
        return;
      }
      if (option.optionId) onDecision(option.decision, undefined, option.optionId);
      else onDecision(option.decision);
    },
    [feedback, onDecision],
  );
  const handleOption = useCallback(
    (index: number) => {
      if (isSubmitting) return;
      const option = options[index];
      if (!option) return;
      if (option.decision === "deny" && option.collectFeedback && !showFeedback) {
        setShowFeedback(true);
        return;
      }
      submitOption(option, index);
    },
    [isSubmitting, options, showFeedback, submitOption],
  );
  const handleDenyWithEnter = useCallback(() => {
    if (isSubmitting) return;
    const denyIndex = options.findIndex((option) => option.decision === "deny");
    if (denyIndex >= 0) submitOption(options[denyIndex], denyIndex);
  }, [isSubmitting, options, submitOption]);
  const handleHotkey = useCallback(
    (index: number) => {
      if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      setHighlightedIndex(index);
      highlightTimerRef.current = setTimeout(() => setHighlightedIndex(null), 300);
      actionTimerRef.current = setTimeout(() => handleOption(index), 150);
    },
    [handleOption],
  );

  return useMemo(
    () => ({
      feedback,
      showFeedback,
      highlightedIndex,
      submittedIndex,
      setFeedback,
      handleOption,
      handleDenyWithEnter,
      handleHotkey,
    }),
    [
      feedback,
      handleDenyWithEnter,
      handleHotkey,
      handleOption,
      highlightedIndex,
      showFeedback,
      submittedIndex,
    ],
  );
}

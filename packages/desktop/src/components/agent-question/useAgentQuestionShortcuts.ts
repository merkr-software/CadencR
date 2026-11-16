import { useScopedHotkeys } from "@/hooks/useScopedHotkeys";
import { useScopedShortcut } from "@/hooks/useShortcut";
import { agentQuestionOptionValue, type AgentQuestion } from "@/types/agent-question";

interface UseAgentQuestionShortcutsParams {
  open: boolean;
  disableShortcuts?: boolean;
  currentQuestion: AgentQuestion | undefined;
  showOther: boolean;
  freeTextFocused: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 0-based index for the "Other" highlight */
  otherShortcutIndex: number;
  handleOptionToggle: (option: string) => void;
  handleOtherToggle: () => void;
  handleNext: () => void;
  handleBack: () => void;
  handleForward: () => void;
  flashHighlight: (index: number) => void;
  onCancel?: () => void;
}

function useQuestionChoiceShortcuts({
  open,
  disableShortcuts,
  currentQuestion,
  otherShortcutIndex,
  handleOptionToggle,
  handleOtherToggle,
  flashHighlight,
}: UseAgentQuestionShortcutsParams): void {
  useScopedShortcut(
    "q-select-1-9",
    (event) => {
      if (!open || !currentQuestion?.options || !/^[1-9]$/.test(event.key)) return;
      const digit = Number(event.key);
      if (digit > currentQuestion.options.length) return;
      event.preventDefault();
      handleOptionToggle(agentQuestionOptionValue(currentQuestion.options[digit - 1]));
      flashHighlight(digit - 1);
    },
    "agent",
    {
      enabled: open && !disableShortcuts,
      enableOnFormTags: false,
      enableOnContentEditable: false,
    },
    [open, disableShortcuts, currentQuestion, handleOptionToggle, flashHighlight],
  );
  useScopedShortcut(
    "q-other",
    (event) => {
      if (!open || !currentQuestion?.options) return;
      event.preventDefault();
      handleOtherToggle();
      flashHighlight(otherShortcutIndex);
    },
    "agent",
    { enabled: open && !disableShortcuts },
    [
      open,
      disableShortcuts,
      currentQuestion,
      handleOtherToggle,
      flashHighlight,
      otherShortcutIndex,
    ],
  );
}

function useQuestionNavigationShortcuts({
  open,
  disableShortcuts,
  currentQuestion,
  showOther,
  freeTextFocused,
  canGoBack,
  canGoForward,
  handleNext,
  handleBack,
  handleForward,
}: UseAgentQuestionShortcutsParams): void {
  useScopedShortcut(
    "q-submit",
    (event) => {
      if (!open || !currentQuestion || showOther || !currentQuestion.options?.length) return;
      event.preventDefault();
      handleNext();
    },
    "agent",
    {
      enabled: open && !disableShortcuts,
      enableOnFormTags: false,
      enableOnContentEditable: false,
    },
    [open, disableShortcuts, currentQuestion, showOther, handleNext],
  );
  useScopedShortcut(
    "q-prev",
    (event) => {
      if (!open || freeTextFocused) return;
      event.preventDefault();
      handleBack();
    },
    "agent",
    {
      enabled: open && !disableShortcuts && canGoBack,
      enableOnFormTags: false,
      enableOnContentEditable: false,
    },
    [open, disableShortcuts, canGoBack, handleBack, freeTextFocused],
  );
  useScopedShortcut(
    "q-next",
    (event) => {
      if (!open || freeTextFocused) return;
      event.preventDefault();
      handleForward();
    },
    "agent",
    {
      enabled: open && !disableShortcuts && canGoForward,
      enableOnFormTags: false,
      enableOnContentEditable: false,
    },
    [open, disableShortcuts, canGoForward, handleForward, freeTextFocused],
  );
}

/**
 * Registers the keyboard shortcuts for the agent question drawer:
 * 1-9 to select an option, Mod+O to toggle "Other", Enter to submit,
 * Left/Right to navigate between questions, and Escape to cancel.
 */
export function useAgentQuestionShortcuts(params: UseAgentQuestionShortcutsParams): void {
  useQuestionChoiceShortcuts(params);
  useQuestionNavigationShortcuts(params);
  const { open, onCancel, disableShortcuts } = params;
  useScopedHotkeys(
    "escape",
    (event) => {
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel?.();
    },
    "agent",
    {
      enabled: open && !!onCancel && !disableShortcuts,
      enableOnFormTags: true,
      enableOnContentEditable: true,
    },
    [open, onCancel, disableShortcuts],
  );
}

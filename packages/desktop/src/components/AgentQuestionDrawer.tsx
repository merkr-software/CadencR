import type { QuestionDraftIdentity } from "@/stores/question-drafts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Loader2Icon, SendIcon } from "lucide-react";
import { AgentQuestionHeader } from "./agent-question/AgentQuestionHeader";
import { AgentQuestionOptionList } from "./agent-question/AgentQuestionOptionList";
import { useAgentQuestionForm } from "./agent-question/useAgentQuestionForm";
import { useAgentQuestionShortcuts } from "./agent-question/useAgentQuestionShortcuts";
import type { AgentQuestion, AgentQuestionAnswers } from "@/types/agent-question";

interface AgentQuestionDrawerProps {
  /** The questions to display */
  questions: AgentQuestion[];
  draftIdentity?: QuestionDraftIdentity;
  isSubmitting?: boolean;
  /** Called when the user submits their response */
  onSubmit: (response: AgentQuestionAnswers) => void;
  /** Called when the user closes the gate without answering it */
  onCancel?: () => void;
  /** Whether the drawer is visible */
  open: boolean;
  /** When true, uses tighter spacing for inline rendering inside AgentPromptBar */
  inline?: boolean;
  /** When true, disables keyboard shortcuts (e.g. when multiple agents have questions) */
  disableShortcuts?: boolean;
}

interface AgentQuestionContentProps {
  form: ReturnType<typeof useAgentQuestionForm>;
  inline?: boolean;
  onCancel?: () => void;
  questionCount: number;
  isSubmitting?: boolean;
}

function AgentQuestionContent({
  form,
  inline,
  onCancel,
  questionCount,
  isSubmitting,
}: AgentQuestionContentProps): React.ReactElement {
  const currentQuestion = form.currentQuestion!;
  const { hasAnswer, isLastQuestion, hasOptions, selectedPreview } = form;
  return (
    <div
      className={cn(
        "agent-prompt-gate-panel bg-card",
        inline ? "px-3 py-2" : "border-t border-border px-4 py-3",
      )}
    >
      {(questionCount > 1 || onCancel) && (
        <AgentQuestionHeader
          questionsLength={questionCount}
          currentIndex={form.currentIndex}
          canGoBack={form.canGoBack}
          canGoForward={form.canGoForward}
          onBack={form.handleBack}
          onForward={form.handleForward}
          onCancel={onCancel}
        />
      )}
      <p className={cn("text-sm font-medium text-foreground", inline ? "mb-2" : "mb-3")}>
        {currentQuestion.question}
      </p>
      {selectedPreview && (
        <pre className="mb-2 overflow-x-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-[11px] leading-tight text-foreground">
          {selectedPreview}
        </pre>
      )}
      {hasOptions && (
        <AgentQuestionOptionList
          options={currentQuestion.options!}
          selectedOptions={form.selectedOptions}
          highlightedIndex={form.highlightedIndex}
          showOther={form.showOther}
          freeTextFocused={form.freeTextFocused}
          onOptionToggle={form.handleOptionToggle}
          onOtherToggle={form.handleOtherToggle}
        />
      )}
      {(form.showOther || !hasOptions) && (
        <div className="mb-2 flex items-center gap-2">
          <Input
            value={form.freeText}
            onChange={(event) => form.setFreeText(event.target.value)}
            onFocus={() => form.setFreeTextFocused(true)}
            onBlur={() => form.setFreeTextFocused(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing)
                form.handleFreeTextSubmit();
            }}
            placeholder="Type your answer..."
            className={cn(
              "text-sm",
              inline &&
                "h-8 border-border/50 bg-muted/40 shadow-none focus-visible:ring-1 focus-visible:ring-ring/40",
            )}
            autoFocus
          />
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" disabled={!hasAnswer} onClick={form.handleNext}>
          {isSubmitting ? (
            <Loader2Icon className="mr-1.5 size-3 animate-spin" />
          ) : (
            <SendIcon className="mr-1.5 size-3" />
          )}
          {isSubmitting ? "Submitting…" : isLastQuestion ? "Submit" : "Next"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Bottom drawer that pushes content up, displaying dynamic forms
 * for AskUserQuestion tool calls from the Claude CLI.
 */
export function AgentQuestionDrawer({
  questions,
  onSubmit,
  onCancel,
  open,
  inline,
  disableShortcuts,
  draftIdentity,
  isSubmitting,
}: AgentQuestionDrawerProps) {
  const form = useAgentQuestionForm({ questions, onSubmit, draftIdentity });

  useAgentQuestionShortcuts({
    open: open && !isSubmitting,
    disableShortcuts,
    onCancel,
    currentQuestion: form.currentQuestion,
    showOther: form.showOther,
    freeTextFocused: form.freeTextFocused,
    canGoBack: form.canGoBack,
    canGoForward: form.canGoForward,
    otherShortcutIndex: form.otherShortcutIndex,
    handleOptionToggle: form.handleOptionToggle,
    handleOtherToggle: form.handleOtherToggle,
    handleNext: form.handleNext,
    handleBack: form.handleBack,
    handleForward: form.handleForward,
    flashHighlight: form.flashHighlight,
  });

  if (!open || !form.currentQuestion) {
    return null;
  }

  return (
    <fieldset disabled={isSubmitting} aria-busy={isSubmitting}>
      <AgentQuestionContent
        isSubmitting={isSubmitting}
        form={form}
        inline={inline}
        onCancel={onCancel}
        questionCount={questions.length}
      />
    </fieldset>
  );
}

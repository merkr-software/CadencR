import { useEffect, useRef, type KeyboardEvent, type ReactElement, type RefObject } from "react";
import { Loader2Icon, SendIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentQuestionHeader } from "@/components/agent-question/AgentQuestionHeader";
import { AgentQuestionOptionList } from "@/components/agent-question/AgentQuestionOptionList";
import {
  useAgentQuestionForm,
  type AgentQuestionForm,
} from "@/components/agent-question/useAgentQuestionForm";
import type { FeatureGateDecision } from "@/api/generated";
import { agentQuestionOptionValue, type AgentQuestion } from "@/types/agent-question";
import { cn } from "@/lib/utils";
import { GATE_BODY_PADDING, gateButtonSize } from "./GateStates";
import { isButton, isTextEntry, pressedDigit, useInitialFocus } from "./gate-keys";

interface QuestionGateBodyProps {
  questions: AgentQuestion[];
  isSubmitting: boolean;
  respond: (decision: FeatureGateDecision) => void;
  autoFocus: boolean;
  touch: boolean;
}

/** What a digit does: picks the n-th option, or the digit after the last one opens "Other". */
function pressDigit(form: AgentQuestionForm, digit: number): boolean {
  const question = form.currentQuestion;
  const options = question?.options ?? [];
  if (digit === options.length + 1) {
    form.handleOtherToggle();
    form.flashHighlight(form.otherShortcutIndex);
    return true;
  }
  const option = options[digit - 1];
  if (!question || !option) return false;
  const value = agentQuestionOptionValue(option);
  if (question.multiSelect) {
    form.handleOptionToggle(value);
    form.flashHighlight(digit - 1);
  } else {
    form.handleChoose(value);
  }
  return true;
}

interface QuestionFieldsProps {
  form: AgentQuestionForm;
  question: AgentQuestion;
  questionCount: number;
  inputRef: RefObject<HTMLInputElement | null>;
  /** The free-text field is showing: "Other" is open, or the question has no options. */
  typing: boolean;
  isSubmitting: boolean;
  touch: boolean;
}

function QuestionFields({
  form,
  question,
  questionCount,
  inputRef,
  typing,
  isSubmitting,
  touch,
}: QuestionFieldsProps): ReactElement {
  // A single-select option answers on click; the rest need the button.
  const setsOwnAnswer = !!question.multiSelect || typing;
  return (
    <>
      {questionCount > 1 ? (
        <AgentQuestionHeader
          questionsLength={questionCount}
          currentIndex={form.currentIndex}
          canGoBack={form.canGoBack}
          canGoForward={form.canGoForward}
          onBack={form.handleBack}
          onForward={form.handleForward}
        />
      ) : null}
      <p className="font-medium leading-snug text-foreground">{question.question}</p>
      {form.selectedPreview ? (
        <pre className="max-h-[6lh] overflow-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11px] leading-tight text-foreground">
          {form.selectedPreview}
        </pre>
      ) : null}
      {form.hasOptions && question.options ? (
        <div data-gate-options="" className="max-h-[min(40vh,16rem)] overflow-y-auto">
          <AgentQuestionOptionList
            options={question.options}
            selectedOptions={form.selectedOptions}
            highlightedIndex={form.highlightedIndex}
            showOther={form.showOther}
            freeTextFocused={form.freeTextFocused}
            onOptionToggle={question.multiSelect ? form.handleOptionToggle : form.handleChoose}
            onOtherToggle={form.handleOtherToggle}
            layout={touch ? "touch" : "compact"}
            otherKey={question.options.length < 9 ? String(question.options.length + 1) : undefined}
          />
        </div>
      ) : null}
      {typing ? (
        <Input
          ref={inputRef}
          value={form.freeText}
          aria-label="Your answer"
          placeholder="Type your answer..."
          className={gateButtonSize(touch)}
          onChange={(event) => form.setFreeText(event.target.value)}
          onFocus={() => form.setFreeTextFocused(true)}
          onBlur={() => form.setFreeTextFocused(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              form.handleFreeTextSubmit();
            }
          }}
        />
      ) : null}
      {setsOwnAnswer || isSubmitting ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!form.hasAnswer || isSubmitting}
            className={gateButtonSize(touch)}
            onClick={form.handleNext}
          >
            {isSubmitting ? (
              <Loader2Icon className="animate-spin" aria-hidden />
            ) : (
              <SendIcon aria-hidden />
            )}
            {isSubmitting ? "Sending…" : form.isLastQuestion ? "Submit" : "Next"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Question gate: the in-chat form, compact; every kind of answer the chat takes. */
export function QuestionGateBody({
  questions,
  isSubmitting,
  respond,
  autoFocus,
  touch,
}: QuestionGateBodyProps): ReactElement {
  const form = useAgentQuestionForm({
    questions,
    onSubmit: (answers) => respond({ type: "question", answers }),
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const question = form.currentQuestion;
  const typing = form.showOther || !form.hasOptions;
  const mounted = useRef(false);

  useInitialFocus(rootRef, "[data-gate-options] button", autoFocus && !typing, form.currentIndex);
  // The user opening "Other" wants to type; a free-text question focuses only if they opened it.
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (typing && (!first || autoFocus)) inputRef.current?.focus();
    // `autoFocus` only matters for the first run.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [typing, form.currentIndex]);

  if (!question) return <div />;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || isSubmitting || isTextEntry(event.target)) return;
    const digit = pressedDigit(event);
    if (digit !== null) {
      if (!pressDigit(form, digit)) return;
    } else if (event.key === "Enter" && !isButton(event.target) && form.hasAnswer) {
      form.handleNext();
    } else {
      return;
    }
    event.preventDefault();
    // The conversation's own digit hotkeys listen on the document.
    event.stopPropagation();
  };

  return (
    // The keys are scoped to this body: no global hotkey is registered.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div ref={rootRef} onKeyDown={onKeyDown}>
      <fieldset
        disabled={isSubmitting}
        aria-busy={isSubmitting}
        className={cn(
          "flex min-w-0 flex-col gap-2",
          GATE_BODY_PADDING,
          touch ? "text-sm" : "text-xs",
        )}
      >
        <QuestionFields
          form={form}
          question={question}
          questionCount={questions.length}
          inputRef={inputRef}
          typing={typing}
          isSubmitting={isSubmitting}
          touch={touch}
        />
      </fieldset>
    </div>
  );
}

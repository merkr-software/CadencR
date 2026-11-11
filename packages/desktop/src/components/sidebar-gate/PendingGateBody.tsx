import { useMemo, type ReactElement } from "react";
import {
  effectiveGateKind,
  gateQuestions,
  PLAN_READY_LABEL,
} from "@/components/sidebar-pending-gate";
import { useFeaturePendingGate } from "@/hooks/useFeaturePendingGate";
import { GateMessage, GateSkeleton } from "./GateStates";
import { PermissionGateBody } from "./PermissionGateBody";
import { QuestionGateBody } from "./QuestionGateBody";

export interface PendingGateBodyProps {
  featureId: number;
  /** Opened by the user (click/tap/shortcut): move focus to the first action. False when the popover opened by itself — never steal focus then. */
  autoFocus: boolean;
  /** Opens the conversation (the shell closes the popover). */
  onOpenConversation: () => void;
  /** Wider/larger touch layout for the mobile bottom sheet. */
  touch?: boolean;
}

/** The sidebar popover's body: answers the conversation's pending permission or question in place. */
export function PendingGateBody({
  featureId,
  autoFocus,
  onOpenConversation,
  touch = false,
}: PendingGateBodyProps): ReactElement {
  const { gate, isLoading, isError, errorMessage, isSubmitting, respond } = useFeaturePendingGate({
    featureId,
    enabled: true,
  });
  const gateKind = gate ? effectiveGateKind(gate) : null;
  const questions = useMemo(
    () => (gate && gateKind === "question" ? gateQuestions(gate) : []),
    [gate, gateKind],
  );
  const message = (text: string, tone: "muted" | "plain"): ReactElement => (
    <GateMessage
      message={text}
      tone={tone}
      touch={touch}
      autoFocus={autoFocus}
      onOpenConversation={onOpenConversation}
    />
  );

  if (isLoading || (isSubmitting && !gate)) return <GateSkeleton touch={touch} />;
  if (isError || !gate || !gateKind) {
    return message(errorMessage ?? "No pending request found.", "muted");
  }
  if (gateKind === "plan") return message(PLAN_READY_LABEL, "plain");
  if (gateKind === "question") {
    if (questions.length === 0) {
      return message("This question can only be answered in the conversation.", "muted");
    }
    return (
      // The request id names one question: a next one starts from a blank form.
      <QuestionGateBody
        key={gate.request_id}
        questions={questions}
        isSubmitting={isSubmitting}
        respond={respond}
        autoFocus={autoFocus}
        touch={touch}
      />
    );
  }
  return (
    <PermissionGateBody
      key={gate.request_id}
      gate={gate}
      isSubmitting={isSubmitting}
      respond={respond}
      onOpenConversation={onOpenConversation}
      autoFocus={autoFocus}
      touch={touch}
    />
  );
}

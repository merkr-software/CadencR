import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PendingPermission } from "@/types/agent-permission";
import type { AgentQuestion } from "@/types/agent-question";
import { useDeferredAgentPrompts } from "./useDeferredAgentPrompts";

const questions: AgentQuestion[] = [{ question: "Which delimiter?" }];

const permission: PendingPermission = {
  toolName: "Bash",
  input: {},
  description: "Run",
  pattern: "Bash(*)",
  requestId: "p-1",
};

interface GateProps {
  pendingPermission?: PendingPermission | null;
  pendingQuestions?: AgentQuestion[];
}

function renderGates(initialProps: GateProps) {
  return renderHook((props: GateProps) => useDeferredAgentPrompts({ ...props, promptText: "" }), {
    initialProps,
  });
}

describe("useDeferredAgentPrompts: Later", () => {
  it("hides the question put off until it is reopened", () => {
    const { result } = renderGates({ pendingQuestions: questions });
    expect(result.current.visibleQuestions).toBe(questions);

    act(() => result.current.putQuestionOff());
    expect(result.current.visibleQuestions).toBeUndefined();
    expect(result.current.questionsLater).toBe(true);
    expect(result.current.questionsDeferred).toBe(false);

    act(() => result.current.reopenQuestion());
    expect(result.current.visibleQuestions).toBe(questions);
    expect(result.current.questionsLater).toBe(false);
  });

  it("shows the next question on its own, even with the same text", () => {
    const { result, rerender } = renderGates({ pendingQuestions: questions });
    act(() => result.current.putQuestionOff());

    const next: AgentQuestion[] = [{ question: "Which delimiter?" }];
    rerender({ pendingQuestions: next });

    expect(result.current.visibleQuestions).toBe(next);
    expect(result.current.questionsLater).toBe(false);
  });

  it("puts a permission off the same way", () => {
    const { result } = renderGates({ pendingPermission: permission });
    act(() => result.current.putPermissionOff());
    expect(result.current.visiblePermission).toBeNull();
    expect(result.current.permissionLater).toBe(true);
    expect(result.current.permissionDeferred).toBe(false);
  });

  it("keeps a permission and a question pending together in separate slots", () => {
    const { result, rerender } = renderGates({
      pendingPermission: permission,
      pendingQuestions: questions,
    });

    act(() => result.current.putPermissionOff());
    act(() => result.current.putQuestionOff());
    expect(result.current.permissionLater).toBe(true);
    expect(result.current.questionsLater).toBe(true);

    // A new permission shows on its own; the question stays put off.
    rerender({
      pendingPermission: { ...permission, requestId: "p-2" },
      pendingQuestions: questions,
    });
    expect(result.current.permissionLater).toBe(false);
    expect(result.current.questionsLater).toBe(true);

    act(() => result.current.putPermissionOff());
    act(() => result.current.reopenQuestion());
    expect(result.current.permissionLater).toBe(true);
    expect(result.current.visibleQuestions).toBe(questions);
  });

  it("frees the slot of an answered request, so one under the same fallback key shows", () => {
    const keyless: PendingPermission = { ...permission, requestId: undefined };
    const { result, rerender } = renderGates({ pendingPermission: keyless });
    act(() => result.current.putPermissionOff());
    expect(result.current.visiblePermission).toBeNull();

    rerender({ pendingPermission: null });
    rerender({ pendingPermission: { ...keyless } });

    expect(result.current.permissionLater).toBe(false);
    expect(result.current.visiblePermission).toEqual(keyless);
  });
});

import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useAgentQuestionForm } from "./useAgentQuestionForm";
import {
  clearQuestionDraft,
  reconcileQuestionDrafts,
  useQuestionDraftStore,
} from "@/stores/question-drafts";

const questions = [
  { question: "Q1" },
  {
    question: "Q2",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    multiSelect: true,
  },
  { question: "Q3" },
];
const identity = { sessionId: 1, requestId: "gate-1" };
const onSubmit = vi.fn();
const mount = (draftIdentity = identity) =>
  renderHook(() => useAgentQuestionForm({ questions, onSubmit, draftIdentity }), {
    wrapper: StrictMode,
  });
beforeEach(() => {
  useQuestionDraftStore.setState({ drafts: new Map() });
  onSubmit.mockReset();
});

it.each(["selection", "other", "empty other", "multiselect"])(
  "retains Q1, step and unfinished Q2 %s across conversation unmount/remount in StrictMode",
  (kind) => {
    const first = mount();
    act(() => first.result.current.setFreeText("first answer"));
    act(() => first.result.current.handleNext());
    if (kind === "selection" || kind === "multiselect")
      act(() => first.result.current.handleOptionToggle("a"));
    if (kind === "multiselect") act(() => first.result.current.handleOptionToggle("b"));
    if (kind !== "selection") act(() => first.result.current.handleOtherToggle());
    if (kind === "other" || kind === "multiselect")
      act(() => first.result.current.setFreeText("unfinished other"));
    first.unmount();
    const second = mount();
    expect(second.result.current.currentIndex).toBe(1);
    expect(second.result.current.selectedOptions).toEqual(
      new Set(kind === "selection" ? ["a"] : kind === "multiselect" ? ["a", "b"] : []),
    );
    expect(second.result.current.showOther).toBe(kind !== "selection");
    expect(second.result.current.freeText).toBe(
      kind === "other" || kind === "multiselect" ? "unfinished other" : "",
    );
    act(() => second.result.current.handleBack());
    expect(second.result.current.freeText).toBe("first answer");
    act(() => second.result.current.handleForward());
    expect(second.result.current.currentIndex).toBe(1);
  },
);

it("separates sessions and new gates even with identical questions", () => {
  const first = mount();
  act(() => first.result.current.setFreeText("session one"));
  first.unmount();
  const otherSession = mount({ ...identity, sessionId: 2 });
  expect(otherSession.result.current.freeText).toBe("");
  act(() => otherSession.result.current.setFreeText("session two"));
  otherSession.unmount();
  const restored = mount();
  expect(restored.result.current.freeText).toBe("session one");
  restored.unmount();
  const newGate = mount({ ...identity, requestId: "gate-2" });
  expect(newGate.result.current.freeText).toBe("");
  expect(newGate.result.current.currentIndex).toBe(0);
});

it("retains edits when questions are rehydrated and when a submit is not confirmed", () => {
  const form = renderHook(
    ({ value }) => useAgentQuestionForm({ questions: value, onSubmit, draftIdentity: identity }),
    { initialProps: { value: questions } },
  );
  act(() => form.result.current.setFreeText("Q1 answer"));
  act(() => form.result.current.handleNext());
  act(() => form.result.current.handleOptionToggle("a"));
  act(() => form.result.current.handleNext());
  act(() => form.result.current.setFreeText("Q3 answer"));
  act(() => form.result.current.handleNext());
  expect(onSubmit).toHaveBeenCalledWith([["Q1 answer"], ["a"], ["Q3 answer"]]);
  form.rerender({ value: structuredClone(questions) });
  expect(form.result.current.currentIndex).toBe(2);
  expect(form.result.current.freeText).toBe("Q3 answer");
  form.unmount();
  expect(mount().result.current.freeText).toBe("Q3 answer");
});

it.each(["closed", "replaced", "permission"])("cleans %s gates while offscreen", (kind) => {
  const form = mount();
  act(() => form.result.current.setFreeText("secret"));
  form.unmount();
  reconcileQuestionDrafts(
    {
      1: {
        status: "question",
        kind: "question",
        requestId: identity.requestId,
        featureId: 1,
        seq: 1,
      },
    },
    kind === "closed"
      ? {}
      : {
          1: {
            status: "question",
            kind: kind === "permission" ? "permission" : "question",
            requestId: "gate-2",
            featureId: 1,
            seq: 2,
          },
        },
  );
  expect(mount().result.current.freeText).toBe("");
});

it("preserves same-gate snapshots and ignores a stale gate cleanup", () => {
  const form = mount();
  act(() => form.result.current.setFreeText("kept"));
  form.unmount();
  reconcileQuestionDrafts(
    {},
    {
      1: {
        status: "question",
        kind: "question",
        requestId: identity.requestId,
        featureId: 1,
        seq: 2,
      },
    },
  );
  clearQuestionDraft(1, "older-gate");
  expect(mount().result.current.freeText).toBe("kept");
});

it("bounds memory across abandoned sessions", () => {
  for (let id = 1; id <= 110; id++) {
    const form = mount({ sessionId: id, requestId: "gate" });
    act(() => form.result.current.setFreeText("draft"));
    form.unmount();
  }
  expect(useQuestionDraftStore.getState().drafts.size).toBe(100);
});

it("does not erase a fresh feature-socket draft with lagging app status", () => {
  const form = mount();
  act(() => form.result.current.setFreeText("fresh draft"));
  form.unmount();
  const old = {
    status: "question" as const,
    kind: "question" as const,
    requestId: "old-gate",
    featureId: 1,
    seq: 1,
  };
  reconcileQuestionDrafts({}, { 2: { ...old, status: "agent" } });
  reconcileQuestionDrafts({ 1: old }, { 1: { ...old, status: "agent", kind: null, seq: 2 } });
  reconcileQuestionDrafts({ 1: old }, {});
  expect(mount().result.current.freeText).toBe("fresh draft");
});

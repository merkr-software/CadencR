import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePromptScheduleControl } from "./usePromptScheduleControl";

describe("usePromptScheduleControl", () => {
  it("schedules the decorated prompt and records the typed one in history", () => {
    const onScheduleRequest = vi.fn();
    const addHistoryEntry = vi.fn();
    const { result } = renderHook(() =>
      usePromptScheduleControl({
        onScheduleRequest,
        featureId: 1,
        enabled: true,
        textRef: { current: " /cadencr:review branch " },
        decorate: (text) => text.replace("/cadencr:review", "/cadencr:review --worktree=new"),
        editorRef: { current: null },
        setText: vi.fn(),
        saveDraft: vi.fn(),
        addHistoryEntry,
        interactedRef: { current: false },
      }),
    );

    result.current?.requestSchedule();
    expect(onScheduleRequest).toHaveBeenCalledWith(
      "/cadencr:review --worktree=new branch",
      expect.any(Function),
    );
    // Once saved, the composer clears like a send and history keeps the typed text.
    const onSaved = onScheduleRequest.mock.calls[0][1] as () => void;
    onSaved();
    expect(addHistoryEntry).toHaveBeenCalledWith("/cadencr:review branch");
  });
});

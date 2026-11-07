/**
 * Feature-isolation tests for `AgentPromptBar`. Prompt drafts are owned by
 * features, not agent session rows.
 */
import { forwardRef, useImperativeHandle, useRef, useState, type ForwardedRef } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test-utils";

vi.mock("@tanstack/react-hotkeys", () => ({ useHotkeys: vi.fn() }));

const usePromptDraftMock = vi.fn(() => ({
  saveDraft: vi.fn(),
  initialDraft: null as string | null,
  draftFeatureId: null as number | null,
}));
// The real hook re-renders its consumer when its draft query resolves; the
// prompt bar is memoized, so a parent re-render with equal props would not.
// `publishDraft()` stands in for that resolution.
const draftUpdates = { version: 0, listeners: new Set<() => void>() };
function publishDraft(): void {
  draftUpdates.version += 1;
  for (const listener of draftUpdates.listeners) listener();
}
vi.mock("@/hooks/usePromptDraft", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void): (() => void) => {
    draftUpdates.listeners.add(listener);
    return () => draftUpdates.listeners.delete(listener);
  };
  return {
    usePromptDraft: (...args: unknown[]) => {
      useSyncExternalStore(subscribe, () => draftUpdates.version);
      return usePromptDraftMock(...(args as []));
    },
  };
});

vi.mock("@/hooks/usePromptHistory", () => ({
  usePromptHistory: vi.fn(() => ({ addEntry: vi.fn(), history: [], resetNavigation: vi.fn() })),
}));

const isMobileMock = vi.fn(() => false);
vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => isMobileMock(),
}));

// Records every `setText(text, moveSelection)` the editor handle receives so
// tests can assert the focus-suppression flag passed on draft restore.
const setTextSpy = vi.fn();

vi.mock("@/hooks/useImageAttachments", () => ({
  useImageAttachments: vi.fn(() => ({
    attachments: [],
    addFiles: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    restoreAttachments: vi.fn(),
    dragHandlers: {},
    isDragging: false,
  })),
}));

vi.mock("./prompt-editor/PromptEditor", () => {
  const MockPromptEditor = forwardRef(function MockPromptEditor(
    { initialText, onChange }: { initialText?: string; onChange?: (text: string) => void },
    ref: ForwardedRef<{ setText: (text: string, moveSelection?: boolean) => void }>,
  ) {
    const [value, setValue] = useState(initialText ?? "");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(
      ref,
      () => ({
        setText: (text: string, moveSelection?: boolean) => {
          setTextSpy(text, moveSelection);
          setValue(text);
          onChange?.(text);
        },
        // Unused by these tests but required by the PromptEditorHandle type.
        focus: () => textareaRef.current?.focus(),
        blur: () => textareaRef.current?.blur(),
        clear: () => setValue(""),
        getText: () => value,
      }),
      [onChange, value],
    );
    return (
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          onChange?.(event.target.value);
        }}
      />
    );
  });
  return { PromptEditor: MockPromptEditor };
});

import { AgentPromptBar } from "./AgentPromptBar";

describe("AgentPromptBar conversation isolation", () => {
  const onSend = vi.fn();
  const onStop = vi.fn();

  beforeEach(() => {
    onSend.mockClear();
    onStop.mockClear();
    setTextSpy.mockClear();
    isMobileMock.mockReturnValue(false);
    usePromptDraftMock.mockClear();
    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: null,
      draftFeatureId: null,
    });
  });

  it("clears the editor when the feature changes", () => {
    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: null,
      draftFeatureId: null,
    });
    const { rerender } = render(
      <AgentPromptBar onSend={onSend} onStop={onStop} status="idle" featureId={10} />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "leftover from feature 10" },
    });

    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: null,
      draftFeatureId: null,
    });
    rerender(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" featureId={11} />);

    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("loads the destination feature's draft after the async fetch resolves", () => {
    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: null,
      draftFeatureId: null,
    });
    const { rerender } = render(
      <AgentPromptBar onSend={onSend} onStop={onStop} status="idle" featureId={10} />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "typed in feature 10" } });

    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: null,
      draftFeatureId: null,
    });
    rerender(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" featureId={11} />);
    expect(screen.getByRole("textbox")).toHaveValue("");

    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: "fresh draft for feature 11",
      draftFeatureId: 11,
    });
    act(() => publishDraft());
    expect(screen.getByRole("textbox")).toHaveValue("fresh draft for feature 11");
  });

  it("does not leak a stale restored draft into the destination feature", () => {
    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: "draft for feature 10",
      draftFeatureId: 10,
    });
    const { rerender } = render(
      <AgentPromptBar onSend={onSend} onStop={onStop} status="idle" featureId={10} />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("draft for feature 10");

    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: "draft for feature 10",
      draftFeatureId: 10,
    });
    rerender(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" featureId={11} />);

    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("clears source text when the destination feature has loaded with no draft", () => {
    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: "draft for feature 10",
      draftFeatureId: 10,
    });
    const { rerender } = render(
      <AgentPromptBar onSend={onSend} onStop={onStop} status="idle" featureId={10} />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("draft for feature 10");

    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: null,
      draftFeatureId: 11,
    });
    rerender(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" featureId={11} />);

    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("restores the feature draft on first mount", () => {
    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: "restored from server",
      draftFeatureId: 10,
    });
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" featureId={10} />);
    expect(screen.getByRole("textbox")).toHaveValue("restored from server");
  });

  it("does not re-inject the draft into the same feature after the user sends", async () => {
    // Race regression: after sending, the input is empty, so the draft-restore
    // guard that only checked `textRef` was open. A draft-query refetch
    // re-delivering the not-yet-cleared draft would then repopulate the box —
    // the message was "sent but kept in the prompt".
    const okSend = vi.fn().mockResolvedValue(undefined);
    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: null,
      draftFeatureId: null,
    });
    const { rerender } = render(
      <AgentPromptBar onSend={okSend} onStop={onStop} status="idle" featureId={10} />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ship it" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    expect(okSend).toHaveBeenCalledWith("ship it", undefined);

    // The debounced draft save lands in the query cache and a refetch delivers
    // it back for the SAME feature while the input sits empty.
    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: "ship it",
      draftFeatureId: 10,
    });
    rerender(<AgentPromptBar onSend={okSend} onStop={onStop} status="idle" featureId={10} />);

    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("does not clear when the ws session changes inside the same feature", () => {
    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: null,
      draftFeatureId: null,
    });
    const { rerender } = render(
      <AgentPromptBar
        onSend={onSend}
        onStop={onStop}
        status="idle"
        featureId={10}
        wsSessionId="ws-A"
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "feature-owned draft" } });

    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: null,
      draftFeatureId: null,
    });
    rerender(
      <AgentPromptBar
        onSend={onSend}
        onStop={onStop}
        status="idle"
        featureId={10}
        wsSessionId="ws-B"
      />,
    );

    expect(screen.getByRole("textbox")).toHaveValue("feature-owned draft");
  });

  it("restores the draft without moving selection on mobile (no keyboard pop)", () => {
    // Regression: draft restore ran `selectEnd()` on every conversation open,
    // which focused the contenteditable and popped the phone keyboard over the
    // transcript. Mobile must restore text without focusing.
    isMobileMock.mockReturnValue(true);
    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: "restored draft",
      draftFeatureId: 10,
    });
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" featureId={10} />);

    expect(screen.getByRole("textbox")).toHaveValue("restored draft");
    expect(setTextSpy).toHaveBeenCalledWith("restored draft", false);
  });

  it("restores the draft with cursor-at-end on desktop (unchanged behavior)", () => {
    isMobileMock.mockReturnValue(false);
    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: "restored draft",
      draftFeatureId: 10,
    });
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" featureId={10} />);

    expect(screen.getByRole("textbox")).toHaveValue("restored draft");
    expect(setTextSpy).toHaveBeenCalledWith("restored draft", true);
  });

  it("threads featureId into usePromptDraft", () => {
    usePromptDraftMock.mockReturnValue({
      saveDraft: vi.fn(),
      initialDraft: null,
      draftFeatureId: null,
    });
    render(<AgentPromptBar onSend={onSend} onStop={onStop} status="idle" featureId={77} />);

    expect(usePromptDraftMock).toHaveBeenCalledWith({
      featureId: 77,
    });
  });
});

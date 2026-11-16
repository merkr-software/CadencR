// @vitest-environment jsdom
// Focus assertions require jsdom's contenteditable behavior.
import { createRef } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test-utils";
import { useIsMobile } from "@/hooks/useIsMobile";
import { AgentPromptBar, type AgentPromptBarHandle } from "./AgentPromptBar";

vi.mock("@tanstack/react-hotkeys", () => ({ useHotkeys: vi.fn() }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: vi.fn() }));
vi.mock("@/hooks/usePromptDraft", () => ({
  usePromptDraft: () => ({ saveDraft: vi.fn() }),
}));
vi.mock("@/hooks/usePromptHistory", () => ({
  usePromptHistory: () => ({ addEntry: vi.fn(), resetNavigation: vi.fn() }),
}));
vi.mock("@/hooks/useImageAttachments", () => ({
  useImageAttachments: () => ({
    attachments: [],
    addFiles: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    restoreAttachments: vi.fn(),
    dragHandlers: {},
    isDragging: false,
  }),
}));

beforeAll(() => {
  // Lexical measures the caret's range when focusing; jsdom has no range geometry.
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
});

describe.each(["mobile", "desktop"] as const)("AgentPromptBar focus on %s", (viewport) => {
  it.each(["success", "failure"] as const)(
    "handles send %s without reopening the mobile keyboard",
    async (outcome) => {
      const isMobile = viewport === "mobile";
      vi.mocked(useIsMobile).mockReturnValue(isMobile);
      let finishSend!: () => void;
      let failSend!: (error: Error) => void;
      const onSend = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            finishSend = resolve;
            failSend = reject;
          }),
      );
      const ref = createRef<AgentPromptBarHandle>();
      render(<AgentPromptBar ref={ref} onSend={onSend} onStop={vi.fn()} status="idle" />);
      const editor = screen.getByRole("textbox");
      await act(async () => ref.current?.setDraft("Retry this prompt"));
      act(() => editor.focus());
      expect(editor).toHaveFocus();

      // Dispatch without moving focus to the button, as a touch submission can do.
      if (isMobile) fireEvent.click(screen.getByLabelText("Send message"));
      else fireEvent.keyDown(editor, { key: "Enter" });

      expect(onSend).toHaveBeenCalledWith("Retry this prompt", undefined);
      expect(screen.getByLabelText("Send message")).toHaveAttribute("aria-busy", "true");
      if (isMobile) expect(editor).not.toHaveFocus();

      await act(async () => {
        if (outcome === "failure") failSend(new Error("Send failed"));
        else finishSend();
      });

      await waitFor(() => {
        expect(screen.getByLabelText("Send message")).toHaveAttribute("aria-busy", "false");
        if (isMobile) expect(editor).not.toHaveFocus();
        else expect(editor).toHaveFocus();
      });
      expect(editor.textContent).toBe(outcome === "failure" ? "Retry this prompt" : "");
    },
  );
});

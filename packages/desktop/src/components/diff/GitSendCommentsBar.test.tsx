import { fireEvent, render, screen } from "@/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShortcutOverridesStore } from "@/lib/shortcuts/overrides";
import { GitSendCommentsBar } from "./GitSendCommentsBar";

function reviews(overrides: Partial<Parameters<typeof GitSendCommentsBar>[0]["reviews"]> = {}) {
  return {
    selectedCount: 2,
    totalCount: 5,
    disabled: false,
    onSend: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  };
}

describe("GitSendCommentsBar", () => {
  afterEach(() => useShortcutOverridesStore.getState().resetAll());

  it("sends the selected review threads directly", () => {
    const onSend = vi.fn();
    render(<GitSendCommentsBar reviews={reviews({ onSend })} />);

    expect(screen.getByText(/of 5 picked/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Send 2 to agent" }));

    expect(onSend).toHaveBeenCalledOnce();
  });

  it("clears the picked set without sending it", () => {
    const onClear = vi.fn();
    render(<GitSendCommentsBar reviews={reviews({ onClear })} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onClear).toHaveBeenCalledOnce();
  });

  it("teaches the pick key instead of reporting a count of zero", () => {
    render(<GitSendCommentsBar reviews={reviews({ selectedCount: 0, disabled: true })} />);

    expect(screen.getByText("Pick threads to send")).toBeVisible();
    expect(screen.queryByText(/of 5 picked/)).not.toBeInTheDocument();
    // Nothing to clear yet, so the escape hatch stays out of the way.
    expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send to agent" })).toBeDisabled();
  });

  it("shows the resolved review shortcut instead of a hardcoded chord", () => {
    useShortcutOverridesStore.getState().setOverride("diff-send-review-comments", { keys: ["f2"] });
    render(<GitSendCommentsBar reviews={reviews({ selectedCount: 1, totalCount: 3 })} />);

    const button = screen.getByRole("button", { name: "Send 1 to agent" });
    fireEvent.pointerEnter(button.closest("div.relative")!, { pointerType: "mouse" });

    expect(screen.getByText("Send picked threads to the agent").parentElement).toHaveTextContent(
      "F2",
    );
  });
});

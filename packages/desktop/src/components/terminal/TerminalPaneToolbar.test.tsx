import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test-utils";
import { TerminalPaneToolbar } from "./TerminalPaneToolbar";

describe("TerminalPaneToolbar", () => {
  it("names each split button after the orientation it fires, like the pane context menu", () => {
    const onSplit = vi.fn();
    render(<TerminalPaneToolbar onSplit={onSplit} onClose={vi.fn()} canClose={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Split terminal horizontally" }));
    expect(onSplit).toHaveBeenLastCalledWith("horizontal");

    fireEvent.click(screen.getByRole("button", { name: "Split terminal vertically" }));
    expect(onSplit).toHaveBeenLastCalledWith("vertical");
  });
});

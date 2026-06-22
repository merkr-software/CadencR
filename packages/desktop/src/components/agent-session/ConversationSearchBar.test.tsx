import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@/test-utils";
import { ConversationSearchBar } from "./ConversationSearchBar";

function setup(overrides: Partial<Parameters<typeof ConversationSearchBar>[0]> = {}) {
  const props = {
    query: "fox",
    matchCount: 3,
    activeNumber: 1,
    focusNonce: 1,
    onQueryChange: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<ConversationSearchBar {...props} />);
  return props;
}

describe("ConversationSearchBar", () => {
  it("autofocuses the input and shows the match counter", () => {
    setup();
    const input = screen.getByLabelText("Find in conversation");
    expect(input).toHaveFocus();
    expect(screen.getByText("1/3")).toBeInTheDocument();
  });

  it("Enter goes to the next match, Shift+Enter to the previous", () => {
    const props = setup();
    const input = screen.getByLabelText("Find in conversation");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onNext).toHaveBeenCalledTimes(1);
    expect(props.onPrev).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(props.onPrev).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the bar", () => {
    const props = setup();
    fireEvent.keyDown(screen.getByLabelText("Find in conversation"), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("arrow buttons navigate and are disabled when there are no matches", () => {
    const props = setup({ query: "zzz", matchCount: 0, activeNumber: 0 });
    fireEvent.click(screen.getByLabelText("Next match"));
    fireEvent.click(screen.getByLabelText("Previous match"));
    // Buttons are disabled, so clicks must not navigate.
    expect(props.onNext).not.toHaveBeenCalled();
    expect(props.onPrev).not.toHaveBeenCalled();
    expect(screen.getByText("0/0")).toBeInTheDocument();
  });

  it("emits query changes as the user types", () => {
    const props = setup({ query: "" });
    fireEvent.change(screen.getByLabelText("Find in conversation"), { target: { value: "bar" } });
    expect(props.onQueryChange).toHaveBeenCalledWith("bar");
  });
});

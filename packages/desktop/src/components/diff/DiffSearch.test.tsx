import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@/test-utils";
import { useRef } from "react";
import { DiffSearch } from "./DiffSearch";
import { formatCompactCombo } from "@/lib/shortcuts/format";

// Wrapper that provides a containerRef
function DiffSearchWrapper({ container }: { container?: HTMLElement }) {
  const ref = useRef<HTMLElement | null>(container ?? null);
  return <DiffSearch containerRef={ref} />;
}

describe("DiffSearch", () => {
  it("renders search input", () => {
    render(<DiffSearchWrapper />);
    expect(screen.getByPlaceholderText("Search in diff")).toBeInTheDocument();
  });

  it("shows navigation controls when query is entered", () => {
    render(<DiffSearchWrapper />);
    const input = screen.getByPlaceholderText("Search in diff");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(
      screen.getByTitle(`Previous match (${formatCompactCombo(["shift", "enter"])})`),
    ).toBeInTheDocument();
    expect(screen.getByTitle("Next match (Enter)")).toBeInTheDocument();
    expect(screen.getByTitle("Clear search (Escape)")).toBeInTheDocument();
  });

  it("hides navigation controls when query is empty", () => {
    render(<DiffSearchWrapper />);
    expect(screen.queryByTitle("Clear search (Escape)")).not.toBeInTheDocument();
  });

  it("clears the query when clear button is clicked", () => {
    render(<DiffSearchWrapper />);
    const input = screen.getByPlaceholderText("Search in diff") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "test" } });
    expect(input.value).toBe("test");
    fireEvent.click(screen.getByTitle("Clear search (Escape)"));
    expect(input.value).toBe("");
  });

  it("shows 0/0 when there are no matches", () => {
    render(<DiffSearchWrapper />);
    const input = screen.getByPlaceholderText("Search in diff");
    fireEvent.change(input, { target: { value: "no-match-here-xyz" } });
    // After debounce (200ms) the count would update, but in tests we just check it renders
    expect(screen.getByText("0/0")).toBeInTheDocument();
  });

  it("clears when Escape is pressed", () => {
    render(<DiffSearchWrapper />);
    const input = screen.getByPlaceholderText("Search in diff") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });
});

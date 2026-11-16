import { describe, it, expect } from "vitest";
import { render, screen } from "@/test-utils";
import { PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import { KbdChord, KbdShortcut } from "./KbdShortcut";

describe("KbdShortcut", () => {
  it("renders text keys", () => {
    render(<KbdShortcut keys={["A"]} />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("renders multiple text keys", () => {
    const { container } = render(<KbdShortcut keys={["ctrl", "S"]} />);
    if (PLATFORM_IS_MAC)
      expect(container.querySelector('[data-kbd-key="Control"]')).toBeInTheDocument();
    else expect(screen.getByText("Ctrl")).toBeInTheDocument();
    expect(screen.getByText("S")).toBeInTheDocument();
  });

  it("renders a platform-correct modifier for cmd/mod keys", () => {
    const { container } = render(<KbdShortcut keys={["cmd"]} />);
    if (PLATFORM_IS_MAC)
      expect(container.querySelector('[data-kbd-key="Command"]')).toBeInTheDocument();
    else expect(screen.getByText("Ctrl")).toBeInTheDocument();
  });

  it("renders the same shift for the shift token, the ⇧ glyph and the Shift word", () => {
    const { container, rerender } = render(<KbdShortcut keys={["shift"]} />);
    const expectShift = () => {
      if (PLATFORM_IS_MAC)
        expect(container.querySelector('[data-kbd-key="Shift"]')).toBeInTheDocument();
      else expect(screen.getByText("Shift")).toBeInTheDocument();
      expect(screen.queryByText("⇧")).toBeNull();
    };
    expectShift();
    rerender(<KbdShortcut keys={["⇧"]} />);
    expectShift();
    rerender(<KbdShortcut keys={["Shift"]} />);
    expectShift();
  });

  it("renders mixed keys", () => {
    const { container } = render(<KbdShortcut keys={["cmd", "S"]} />);
    if (PLATFORM_IS_MAC)
      expect(container.querySelector('[data-kbd-key="Command"]')).toBeInTheDocument();
    else expect(screen.getByText("Ctrl")).toBeInTheDocument();
    expect(screen.getByText("S")).toBeInTheDocument();
  });

  it("renders as kbd element", () => {
    const { container } = render(<KbdShortcut keys={["X"]} />);
    expect(container.querySelector("kbd")).toBeInTheDocument();
  });

  it("renders square variant", () => {
    const { container } = render(<KbdShortcut keys={["1"]} variant="square" />);
    const kbd = container.querySelector("kbd");
    expect(kbd).toBeInTheDocument();
    expect(kbd?.className).toContain("h-6");
    expect(kbd?.className).toContain("min-w-6");
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("renders modal variant", () => {
    const { container } = render(<KbdShortcut keys={["⌘"]} variant="modal" />);
    const kbd = container.querySelector("kbd");
    expect(kbd).toBeInTheDocument();
    expect(kbd?.className).toContain("h-5");
    expect(kbd?.className).not.toContain("font-mono");
  });

  it("renders a chord as one key cap per key", () => {
    const { container } = render(<KbdChord keys={["⌘", "⇧", "/"]} />);
    expect(container.querySelectorAll("kbd")).toHaveLength(3);
    expect(screen.getByText("/")).toBeInTheDocument();
  });

  it("renders a dimmed placeholder instead of the keys when disabled", () => {
    const { container } = render(<KbdShortcut keys={["1"]} variant="square" disabled />);
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.getByText("-")).toBeInTheDocument();
    expect(container.querySelector("kbd")?.className).toContain("opacity-50");
  });
});

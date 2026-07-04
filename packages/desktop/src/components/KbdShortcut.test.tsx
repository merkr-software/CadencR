import { describe, it, expect } from "vitest";
import { render, screen } from "@/test-utils";
import { PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import { KbdShortcut } from "./KbdShortcut";

describe("KbdShortcut", () => {
  it("renders text keys", () => {
    render(<KbdShortcut keys={["A"]} />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("renders multiple text keys", () => {
    render(<KbdShortcut keys={["ctrl", "S"]} />);
    expect(screen.getByText(PLATFORM_IS_MAC ? "⌃" : "Ctrl")).toBeInTheDocument();
    expect(screen.getByText("S")).toBeInTheDocument();
  });

  it("renders a platform-correct modifier for cmd/mod keys", () => {
    const { container } = render(<KbdShortcut keys={["cmd"]} />);
    if (PLATFORM_IS_MAC) expect(container.querySelector("svg")).toBeInTheDocument();
    else expect(screen.getByText("Ctrl")).toBeInTheDocument();
  });

  it("renders enter icon for enter key", () => {
    const { container } = render(<KbdShortcut keys={["enter"]} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renders the ArrowUp shift icon for both the shift token and the ⇧ glyph", () => {
    const { container, rerender } = render(<KbdShortcut keys={["shift"]} />);
    expect(container.querySelector(".lucide-arrow-up")).toBeInTheDocument();
    expect(container.querySelector("svg")?.className.baseVal).toContain("-translate-y-px");
    expect(screen.queryByText("⇧")).toBeNull();

    rerender(<KbdShortcut keys={["⇧"]} />);
    expect(container.querySelector(".lucide-arrow-up")).toBeInTheDocument();
    expect(container.querySelector("svg")?.className.baseVal).toContain("-translate-y-px");
    expect(screen.queryByText("⇧")).toBeNull();
  });

  it("renders mixed keys", () => {
    const { container } = render(<KbdShortcut keys={["cmd", "S"]} />);
    if (PLATFORM_IS_MAC) expect(container.querySelector("svg")).toBeInTheDocument();
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
    expect(kbd?.className).toContain("font-mono");
  });

  it("renders a dimmed placeholder instead of the keys when disabled", () => {
    const { container } = render(<KbdShortcut keys={["1"]} variant="square" disabled />);
    expect(screen.queryByText("1")).toBeNull();
    expect(screen.getByText("-")).toBeInTheDocument();
    expect(container.querySelector("kbd")?.className).toContain("opacity-50");
  });
});

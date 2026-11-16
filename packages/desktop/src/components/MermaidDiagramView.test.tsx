// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@/test-utils";
import { MermaidDiagramView } from "./MermaidDiagramView";

const SVG =
  '<svg viewBox="0 0 200 100" data-testid="diagram-svg"><rect width="200" height="100" /></svg>';

describe("MermaidDiagramView", () => {
  it("injects the SVG and exposes zoom controls", () => {
    render(<MermaidDiagramView svg={SVG} />);
    expect(screen.getByTestId("diagram-svg")).toBeInTheDocument();
    expect(screen.getByTitle("Zoom in (+)")).toBeInTheDocument();
    expect(screen.getByTitle("Zoom out (−)")).toBeInTheDocument();
    expect(screen.getByTitle("Reset zoom (0)")).toBeInTheDocument();
  });

  it("handles zoom and reset clicks without throwing", () => {
    render(<MermaidDiagramView svg={SVG} />);
    // jsdom has no real layout, but the control handlers must stay resilient.
    expect(() => {
      fireEvent.click(screen.getByTitle("Zoom in (+)"));
      fireEvent.click(screen.getByTitle("Zoom out (−)"));
      fireEvent.click(screen.getByTitle("Reset zoom (0)"));
    }).not.toThrow();
    // The diagram is still mounted after interaction.
    expect(screen.getByTestId("diagram-svg")).toBeInTheDocument();
  });

  it("offers full screen inline only when the caller can open it", () => {
    const onExpand = vi.fn();
    const { rerender } = render(<MermaidDiagramView svg={SVG} />);
    expect(screen.queryByTitle("Full screen")).not.toBeInTheDocument();

    rerender(<MermaidDiagramView svg={SVG} onExpand={onExpand} />);
    fireEvent.click(screen.getByTitle("Full screen"));
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it("keeps zoom controls and an exit button in the full-screen variant", () => {
    const onClose = vi.fn();
    render(<MermaidDiagramView svg={SVG} variant="fullscreen" onClose={onClose} />);
    expect(screen.getByTitle("Zoom in (+)")).toBeInTheDocument();
    expect(screen.getByTitle("Reset zoom (0)")).toBeInTheDocument();
    expect(screen.queryByTitle("Full screen")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Exit full screen (Esc)"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("zooms from the keyboard in full screen", () => {
    render(<MermaidDiagramView svg={SVG} variant="fullscreen" onClose={vi.fn()} />);
    const content = screen.getByTestId("diagram-svg").parentElement;
    if (!content) throw new Error("diagram wrapper missing");
    const width = () => content.style.width;
    const fitted = width();
    fireEvent.keyDown(content, { key: "+" });
    expect(width()).not.toBe(fitted);
    fireEvent.keyDown(content, { key: "0" });
    expect(width()).toBe(fitted);
  });
});

it.each(["inline", "fullscreen"] as const)("sanitizes the final SVG in %s view", (variant) => {
  const svg =
    '<svg data-testid="safe-svg" onload="alert(1)"><script>alert(1)</script><foreignObject><div>hostile HTML</div></foreignObject><text onclick="alert(1)">Label</text><image href="https://evil.test/image" /></svg>';
  const props = variant === "fullscreen" ? { variant, onClose: vi.fn() } : { variant };
  const { container } = render(<MermaidDiagramView svg={svg} {...props} />);
  const diagram = screen.getByTestId("safe-svg");
  expect(diagram.querySelector("script, foreignObject")).toBeNull();
  expect(diagram.innerHTML).not.toMatch(/onload|onclick|https:\/\/evil/);
  expect(container.textContent).toContain("Label");
});

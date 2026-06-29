import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@/test-utils";
import { MermaidDiagramView } from "./MermaidDiagramView";

const SVG =
  '<svg viewBox="0 0 200 100" data-testid="diagram-svg"><rect width="200" height="100" /></svg>';

describe("MermaidDiagramView", () => {
  it("injects the SVG and exposes zoom controls", () => {
    render(<MermaidDiagramView svg={SVG} />);
    expect(screen.getByTestId("diagram-svg")).toBeInTheDocument();
    expect(screen.getByTitle("Zoom in")).toBeInTheDocument();
    expect(screen.getByTitle("Zoom out")).toBeInTheDocument();
    expect(screen.getByTitle("Reset zoom")).toBeInTheDocument();
  });

  it("handles zoom and reset clicks without throwing", () => {
    render(<MermaidDiagramView svg={SVG} />);
    // jsdom has no real layout, but the control handlers must stay resilient.
    expect(() => {
      fireEvent.click(screen.getByTitle("Zoom in"));
      fireEvent.click(screen.getByTitle("Zoom out"));
      fireEvent.click(screen.getByTitle("Reset zoom"));
    }).not.toThrow();
    // The diagram is still mounted after interaction.
    expect(screen.getByTestId("diagram-svg")).toBeInTheDocument();
  });
});

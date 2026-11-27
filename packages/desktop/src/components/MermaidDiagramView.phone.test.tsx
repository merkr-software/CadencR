// @vitest-environment jsdom
// jsdom: the SVG's viewBox must be parsed to size the preview.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import { MermaidDiagramView } from "./MermaidDiagramView";

const layout = vi.hoisted(() => ({ phone: true }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => layout.phone }));

beforeEach(() => {
  layout.phone = true;
});

/** A trackpad pinch: a ctrl-modified wheel over the viewport. */
function pinchWheel(target: Element): WheelEvent {
  const event = new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, cancelable: true });
  act(() => void target.dispatchEvent(event));
  return event;
}

const TALL =
  '<svg viewBox="0 0 200 900" data-testid="diagram-svg"><rect width="200" height="900" /></svg>';

describe("MermaidDiagramView on the phone layout", () => {
  it("shows a clipped preview with no zoom controls and no inner scroll", () => {
    const { container } = render(<MermaidDiagramView svg={TALL} onExpand={() => undefined} />);
    expect(screen.queryByTitle("Zoom in (+)")).not.toBeInTheDocument();
    const viewport = screen.getByTestId("diagram-svg").parentElement?.parentElement;
    expect(viewport).toHaveClass("overflow-hidden", "max-h-60");
    expect(viewport).not.toHaveClass("overflow-auto");
    expect(container.querySelector('[data-rich-fade="bottom"]')).toBeInTheDocument();
  });

  it("opens full screen from Expand", async () => {
    const onExpand = vi.fn();
    const { user } = render(<MermaidDiagramView svg={TALL} onExpand={onExpand} />);
    await user.click(screen.getByRole("button", { name: "Expand diagram" }));
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it("gives full screen a titled 44px header and a finger-pannable viewport", () => {
    const onClose = vi.fn();
    render(<MermaidDiagramView svg={TALL} variant="fullscreen" onClose={onClose} />);
    expect(screen.getByText("Diagram")).toBeInTheDocument();
    expect(screen.getByTitle("Exit full screen (Esc)")).toBeInTheDocument();
    expect(screen.getByText("Esc to close")).toHaveAttribute("data-kbd-hint");
    const viewport = screen.getByTestId("diagram-svg").parentElement?.parentElement;
    expect(viewport).toHaveClass("touch-pan-x", "touch-pan-y", "overflow-auto");
  });

  it("does not zoom the phone preview with a wheel", () => {
    render(<MermaidDiagramView svg={TALL} onExpand={() => undefined} />);
    const viewport = screen.getByTestId("diagram-svg").parentElement?.parentElement;
    if (!viewport) throw new Error("no viewport");
    expect(pinchWheel(viewport).defaultPrevented).toBe(false);
  });

  it("zooms with the wheel again after flipping from the phone layout to the desktop one", () => {
    const { rerender } = render(<MermaidDiagramView svg={TALL} onExpand={() => undefined} />);
    layout.phone = false;
    // A new prop stands in for the layout's own re-render (the view is memoized).
    rerender(<MermaidDiagramView svg={TALL} onExpand={() => 1} />);

    const content = screen.getByTestId("diagram-svg").parentElement;
    const viewport = content?.parentElement;
    if (!content || !viewport) throw new Error("no viewport");
    expect(viewport).toHaveClass("overflow-auto");
    const before = content.style.width;
    expect(pinchWheel(viewport).defaultPrevented).toBe(true);
    expect(content.style.width).not.toBe(before);
  });
});

import { describe, it, expect } from "vitest";
import { render, screen } from "@/test-utils";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./resizable";

describe("Resizable", () => {
  it("renders panels with content", () => {
    render(
      <ResizablePanelGroup {...({ direction: "horizontal" } as Record<string, string>)}>
        <ResizablePanel defaultSize={50}>Left panel</ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={50}>Right panel</ResizablePanel>
      </ResizablePanelGroup>,
    );
    expect(screen.getByText("Left panel")).toBeInTheDocument();
    expect(screen.getByText("Right panel")).toBeInTheDocument();
  });

  it("renders handle element with data-slot", () => {
    const { container } = render(
      <ResizablePanelGroup {...({ direction: "horizontal" } as Record<string, string>)}>
        <ResizablePanel defaultSize={50}>Left</ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={50}>Right</ResizablePanel>
      </ResizablePanelGroup>,
    );
    expect(container.querySelector("[data-slot='resizable-handle']")).toBeInTheDocument();
  });

  it("hides a disabled handle and lets pointers through it", () => {
    const { container } = render(
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize={50}>Left</ResizablePanel>
        <ResizableHandle disabled />
        <ResizablePanel defaultSize={50}>Right</ResizablePanel>
      </ResizablePanelGroup>,
    );
    const handle = container.querySelector("[data-slot='resizable-handle']");
    expect(handle?.getAttribute("aria-disabled")).toBe("true");
    expect(handle?.className).toContain("aria-disabled:invisible");
    expect(handle?.className).toContain("aria-disabled:pointer-events-none");
  });

  it("renders panel group with data-slot", () => {
    const { container } = render(
      <ResizablePanelGroup {...({ direction: "vertical" } as Record<string, string>)}>
        <ResizablePanel defaultSize={100}>Content</ResizablePanel>
      </ResizablePanelGroup>,
    );
    expect(container.querySelector("[data-slot='resizable-panel-group']")).toBeInTheDocument();
  });
});

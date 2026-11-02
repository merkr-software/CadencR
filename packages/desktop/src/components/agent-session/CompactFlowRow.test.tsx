import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBlockData } from "@/types/agent-block";

const lineRenders = vi.hoisted(() => new Map<string, number>());
vi.mock("./CompactToolLine", async () => {
  const { memo } = await import("react");
  return {
    CompactToolLine: memo(function MockLine({ block }: { block: AgentBlockData }) {
      lineRenders.set(block.id, (lineRenders.get(block.id) ?? 0) + 1);
      return <span>{block.id}</span>;
    }),
  };
});

const { CompactFlowRow } = await import("./CompactFlowRow");

function tools(count: number, toolName = "Read"): AgentBlockData[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `tool-${index}`,
    type: "tool_call" as const,
    content: "",
    toolName,
  }));
}

function lineIds(): string[] {
  return screen.getAllByText(/^tool-/).map((element) => element.textContent ?? "");
}

describe("CompactFlowRow", () => {
  // Animations off: the list mounts and unmounts with no transition window.
  beforeAll(() => {
    document.documentElement.dataset.animations = "off";
  });
  afterAll(() => {
    delete document.documentElement.dataset.animations;
  });

  it("folds the run to its most recent step with a count of the others", () => {
    render(<CompactFlowRow blocks={tools(4)} />);

    expect(lineIds()).toEqual(["tool-3"]);
    expect(screen.getByRole("button", { expanded: false })).toHaveTextContent("+3");
  });

  it("lists every step newest first when clicked, and folds back", () => {
    render(<CompactFlowRow blocks={tools(4)} />);

    fireEvent.click(screen.getByRole("button"));
    expect(lineIds()).toEqual(["tool-3", "tool-2", "tool-1", "tool-0"]);
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button"));
    expect(lineIds()).toEqual(["tool-3"]);
  });

  it("anchors each rendered step for search highlighting", () => {
    const { container } = render(<CompactFlowRow blocks={tools(3)} />);
    fireEvent.click(screen.getByRole("button"));

    const anchors = [...container.querySelectorAll("[data-block-id]")].map((element) =>
      element.getAttribute("data-block-id"),
    );
    expect(anchors).toEqual(["tool-2", "tool-1", "tool-0"]);
  });

  it("has nothing to unfold for a single step", () => {
    render(<CompactFlowRow blocks={tools(1)} />);

    expect(lineIds()).toEqual(["tool-0"]);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("skips steps that draw no line", () => {
    const blocks = [...tools(2), { ...tools(1, "TodoWrite")[0], id: "todo" }];
    render(<CompactFlowRow blocks={blocks} />);

    expect(lineIds()).toEqual(["tool-1"]);
    expect(screen.getByRole("button")).toHaveTextContent("+1");
  });

  it("only renders the new step and the one it pushes into the list when the run grows", () => {
    lineRenders.clear();
    const blocks = tools(3);
    const { rerender } = render(<CompactFlowRow blocks={blocks.slice(0, 2)} />);
    fireEvent.click(screen.getByRole("button"));
    lineRenders.clear();

    rerender(<CompactFlowRow blocks={blocks} />);

    expect(lineIds()).toEqual(["tool-2", "tool-1", "tool-0"]);
    expect(Object.fromEntries(lineRenders)).toEqual({ "tool-2": 1, "tool-1": 1 });
  });

  it("names the button after the step it shows and the steps it hides", () => {
    render(<CompactFlowRow blocks={tools(3)} />);

    expect(screen.getByRole("button")).toHaveAccessibleName("tool-2 +2 earlier steps");
  });

  describe("with animations on", () => {
    beforeEach(() => {
      delete document.documentElement.dataset.animations;
    });
    afterEach(() => {
      document.documentElement.dataset.animations = "off";
    });

    const head = (container: HTMLElement) => container.querySelector("[data-block-id]");

    it("scrolls a new head step in, but not the head a row mounts with", () => {
      const blocks = tools(3);
      const { container, rerender } = render(<CompactFlowRow blocks={blocks.slice(0, 2)} />);
      expect(head(container)?.className).not.toContain("animate-step-in");

      rerender(<CompactFlowRow blocks={blocks} />);

      expect(head(container)?.getAttribute("data-block-id")).toBe("tool-2");
      expect(head(container)?.className).toContain("animate-step-in");
      expect(container.querySelector("[data-leaving-step]")).toHaveTextContent("tool-1");
    });

    it("ends the hand-over with its animation, so a re-shown pane does not replay it", () => {
      const blocks = tools(3);
      const { container, rerender } = render(<CompactFlowRow blocks={blocks.slice(0, 2)} />);
      rerender(<CompactFlowRow blocks={blocks} />);
      const leaving = container.querySelector("[data-leaving-step]");
      expect(leaving?.className).toContain("animate-step-out");

      fireEvent.animationEnd(leaving as Element);

      expect(container.querySelector("[data-leaving-step]")).toBeNull();
      expect(head(container)?.className).not.toContain("animate-step-in");
    });
  });

  it("swaps the head without a scroll when animations are off", () => {
    const blocks = tools(2);
    const { container, rerender } = render(<CompactFlowRow blocks={blocks.slice(0, 1)} />);

    rerender(<CompactFlowRow blocks={blocks} />);

    expect(container.querySelector("[data-leaving-step]")).toBeNull();
    expect(container.querySelector("[data-block-id]")?.className).not.toContain("animate");
  });

  it("unfolds when the search lands on a folded step", () => {
    const blocks = tools(4);
    const { rerender } = render(<CompactFlowRow blocks={blocks} />);
    expect(lineIds()).toEqual(["tool-3"]);

    rerender(<CompactFlowRow blocks={blocks} revealBlockId="tool-1" />);

    expect(lineIds()).toEqual(["tool-3", "tool-2", "tool-1", "tool-0"]);
  });

  it("mounts a long run's steps a page at a time", () => {
    render(<CompactFlowRow blocks={tools(150)} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(lineIds()).toHaveLength(101);
    fireEvent.click(screen.getByRole("button", { name: "Show 49 older steps" }));
    expect(lineIds()).toHaveLength(150);
  });

  it("mounts past the page when the search lands on an old step", () => {
    render(<CompactFlowRow blocks={tools(150)} revealBlockId="tool-0" />);

    expect(lineIds()).toHaveLength(150);
  });

  it("rerenders when path-dependent line presentation changes", () => {
    lineRenders.clear();
    const blocks = tools(1);
    const { rerender } = render(<CompactFlowRow blocks={blocks} basePath="/first" />);

    rerender(<CompactFlowRow blocks={[...blocks]} basePath="/second" />);

    expect(lineRenders.get("tool-0")).toBe(2);
  });
});

// @vitest-environment jsdom
// Pinned to jsdom: asserts inline layout styles as jsdom serializes them.
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test-utils";
import type { Feature } from "@/api/generated";
import type { FeatureTreeNode } from "@/lib/feature-hierarchy";
import { VirtualizedProjectFeatureList } from "./VirtualizedProjectFeatureList";
import { VirtualizedArchivedFeatureList } from "./VirtualizedArchivedFeatureList";

vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef(function VirtuosoMock(
    props: {
      data: unknown[];
      itemContent: (index: number, item: unknown) => ReactNode;
      rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
      style?: CSSProperties;
    },
    ref,
  ) {
    const [start, setStart] = useState(0);
    useImperativeHandle(ref, () => ({
      scrollIntoView: ({ index }: { index: number }) => setStart(Math.max(0, index - 2)),
      scrollToIndex: ({ index }: { index: number }) => setStart(Math.max(0, index - 2)),
    }));
    const end = Math.min(props.data.length - 1, start + 5);
    useEffect(
      () => props.rangeChanged?.({ startIndex: start, endIndex: end }),
      [end, props, start],
    );
    useEffect(() => {
      const scroll = (event: Event) => setStart((event as CustomEvent<number>).detail);
      window.addEventListener("virtuoso-test-scroll", scroll);
      return () => window.removeEventListener("virtuoso-test-scroll", scroll);
    }, []);
    return (
      <div style={props.style}>
        {props.data
          .slice(start, end + 1)
          .map((item, offset) => props.itemContent(start + offset, item))}
      </div>
    );
  }),
}));

function feature(id: number, parentId?: number): Feature {
  return {
    id,
    title: `Conversation ${id}`,
    status: "active",
    type: "ws-session",
    project_id: 1,
    created_at: "2026-01-01T00:00:00Z",
    is_pinned: false,
    spawned_by_feature_id: parentId ?? null,
  };
}

function renderList({ activeFeatureId = null }: { activeFeatureId?: number | null } = {}) {
  const root = feature(1);
  const children = Array.from({ length: 99 }, (_, index) => feature(index + 2, 1));
  const rootNode: FeatureTreeNode = {
    feature: root,
    children: children.map((child) => ({ feature: child, children: [] })),
  };
  const secondRoot = feature(101);
  const secondRootNode: FeatureTreeNode = {
    feature: secondRoot,
    children: Array.from({ length: 99 }, (_, index) => ({
      feature: feature(index + 102, 101),
      children: [],
    })),
  };
  const view = (nextActiveFeatureId: number | null) => (
    <div data-radix-scroll-area-viewport>
      <VirtualizedProjectFeatureList
        activeFeatureId={nextActiveFeatureId}
        flatActiveFeatures={[root, secondRoot]}
        renderFeature={(item, control, depth) => (
          <div role="button" tabIndex={0} data-nav-item data-depth={depth}>
            {control}
            {item.title}
          </div>
        )}
        rootNodeByFeatureId={
          new Map([
            [root.id, rootNode],
            [secondRoot.id, secondRootNode],
          ])
        }
        worktreeGroups={[]}
      />
    </div>
  );
  const result = render(view(activeFeatureId));
  return {
    ...result,
    rerenderActive: (nextActiveFeatureId: number | null) =>
      result.rerender(view(nextActiveFeatureId)),
  };
}

describe("VirtualizedProjectFeatureList", () => {
  it("bounds a large expanded hierarchy and preserves collapse state after recycling", async () => {
    renderList();
    expect(await screen.findAllByRole("listitem")).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Collapse child sessions" }));
    const firstVisible = screen.getByText("Conversation 1");
    firstVisible.blur();
    act(() => {
      firstVisible.dispatchEvent(
        new CustomEvent("cadencr-sidebar-navigate", {
          bubbles: true,
          detail: { direction: "up", handled: false },
        }),
      );
    });
    expect(await screen.findByText("Conversation 200")).toBeInTheDocument();
    screen.getByText("Conversation 200").blur();
    act(() => {
      screen.getByText("Conversation 200").dispatchEvent(
        new CustomEvent("cadencr-sidebar-navigate", {
          bubbles: true,
          detail: { direction: "down", handled: false },
        }),
      );
    });
    expect(
      await screen.findByRole("button", { name: "Expand child sessions" }),
    ).toBeInTheDocument();
  });

  it("reveals an active offscreen descendant", async () => {
    renderList({ activeFeatureId: 90 });
    expect(await screen.findByText("Conversation 90")).toBeInTheDocument();
  });

  it("re-expands a collapsed ancestor when its descendant becomes active", async () => {
    const view = renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Collapse child sessions" }));
    expect(screen.queryByText("Conversation 90")).not.toBeInTheDocument();
    view.rerenderActive(90);
    expect(await screen.findByText("Conversation 90")).toBeInTheDocument();
    expect(screen.getByText("Conversation 90")).toHaveAttribute("data-depth", "1");
  });

  it("does not snap back after the user scrolls away from the active row", async () => {
    renderList({ activeFeatureId: 90 });
    await screen.findByText("Conversation 90");
    act(() => window.dispatchEvent(new CustomEvent("virtuoso-test-scroll", { detail: 0 })));
    expect(await screen.findByText("Conversation 1")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Conversation 90")).not.toBeInTheDocument());
  });

  it("focuses logical last without snapping back to the active row", async () => {
    renderList({ activeFeatureId: 90 });
    await screen.findByText("Conversation 90");
    act(() => {
      screen.getByRole("list", { name: "Conversations" }).dispatchEvent(
        new CustomEvent("cadencr-sidebar-navigate", {
          bubbles: true,
          detail: { direction: "up", handled: false },
        }),
      );
    });
    await waitFor(() => expect(screen.getByText("Conversation 200")).toHaveFocus());
    expect(screen.queryByText("Conversation 90")).not.toBeInTheDocument();
  });

  it("moves focus to an offscreen logical sibling after virtualization completes", async () => {
    renderList();
    const sixth = await screen.findByText("Conversation 6");
    sixth.focus();
    const detail = { direction: "down" as const, handled: false };
    act(() => {
      sixth.dispatchEvent(new CustomEvent("cadencr-sidebar-navigate", { bubbles: true, detail }));
    });
    expect(detail.handled).toBe(true);
    await waitFor(() => expect(screen.getByText("Conversation 7")).toHaveFocus());
  });

  it("enters the virtual list at its logical boundary", async () => {
    renderList();
    const visibleRow = await screen.findByText("Conversation 1");
    (document.activeElement as HTMLElement)?.blur();
    const detail = { direction: "up" as const, handled: false };
    act(() => {
      visibleRow.dispatchEvent(
        new CustomEvent("cadencr-sidebar-navigate", { bubbles: true, detail }),
      );
    });
    expect(detail.handled).toBe(true);
    await waitFor(() => expect(screen.getByText("Conversation 200")).toHaveFocus());
  });
});

describe("VirtualizedArchivedFeatureList", () => {
  it("keeps the original five-row viewport while bounding archived DOM", async () => {
    render(
      <VirtualizedArchivedFeatureList
        features={Array.from({ length: 1_000 }, (_, index) => feature(index + 1))}
        expanded
        onToggle={vi.fn()}
        activeFeatureId={null}
        renderFeature={(item) => <div data-nav-item>{item.title}</div>}
      />,
    );
    expect(await screen.findAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByLabelText("Archived conversations").firstElementChild).toHaveStyle({
      height: "11.25rem",
    });
  });

  it("sizes fewer than five archived rows naturally", async () => {
    render(
      <VirtualizedArchivedFeatureList
        features={[feature(1), feature(2), feature(3)]}
        expanded
        onToggle={vi.fn()}
        activeFeatureId={null}
        renderFeature={(item) => <div data-nav-item>{item.title}</div>}
      />,
    );
    await screen.findByText("Conversation 3");
    expect(screen.getByLabelText("Archived conversations").firstElementChild).toHaveStyle({
      height: "6.75rem",
    });
  });
});

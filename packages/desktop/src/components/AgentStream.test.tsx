import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@/test-utils";
import { AgentStream } from "./AgentStream";
import type { AgentBlockData } from "./AgentBlock";

const virtuosoState = vi.hoisted(() => ({
  firstItemIndex: undefined as number | undefined,
  customScrollParent: undefined as HTMLElement | undefined,
  hasScrollerRef: false,
  startReached: undefined as (() => void) | undefined,
  rangeChanged: undefined as
    | ((range: { startIndex: number; endIndex: number }) => void)
    | undefined,
}));

// Mock Virtuoso so JSDOM tests render all items synchronously instead of
// relying on layout/IntersectionObserver. Real virtualization is exercised
// in the running app; here we just need block content reachable in the DOM.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    firstItemIndex,
    computeItemKey,
    customScrollParent,
    scrollerRef,
    startReached,
    rangeChanged,
    components,
    context,
  }: {
    data?: AgentBlockData[];
    itemContent?: (index: number, block: AgentBlockData, context: unknown) => ReactNode;
    firstItemIndex?: number;
    computeItemKey?: (index: number, block: AgentBlockData) => string;
    customScrollParent?: HTMLElement;
    scrollerRef?: (ref: HTMLElement | null) => void;
    startReached?: () => void;
    rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
    components?: { Footer?: (props: { context?: unknown }) => ReactNode };
    context?: unknown;
  }) => {
    virtuosoState.firstItemIndex = firstItemIndex;
    virtuosoState.customScrollParent = customScrollParent;
    virtuosoState.hasScrollerRef = typeof scrollerRef === "function";
    virtuosoState.startReached = startReached;
    virtuosoState.rangeChanged = rangeChanged;
    return (
      <div data-testid="virtuoso-mock">
        {data?.map((item, i) => (
          <div key={computeItemKey?.((firstItemIndex ?? 0) + i, item) ?? item.id}>
            {itemContent?.((firstItemIndex ?? 0) + i, item, context)}
          </div>
        ))}
        {components?.Footer ? <components.Footer context={context} /> : null}
      </div>
    );
  },
}));

// Break the AgentBlock → TaskAgentBlock → AgentStreamItem → AgentBlock import
// cycle before `importActual("./AgentBlock")` below pulls it: loading the real
// TaskAgentBlock re-enters AgentBlock mid-mock and leaves the AgentBlock export
// unresolved, so AgentStreamItem renders nothing. Subagent panels aren't
// exercised here, so a stub is enough.
vi.mock("./TaskAgentBlock", () => ({ TaskAgentBlock: () => null }));

// ToolSummaryBlock (summary-mode recap) adds the same AgentBlock →
// ToolSummaryBlock → AgentStreamItem → AgentBlock cycle; stub it for the same
// reason. Summary rendering is covered by agentStreamSummary.test.ts.
vi.mock("./agent-session/ToolSummaryBlock", () => ({ ToolSummaryBlock: () => null }));

// Per-block render counts captured by the AgentBlock mock. Tests that care
// about the memoisation of `AgentStreamItem` read this map after re-rendering.
const blockRenderCounts = new Map<string, number>();

vi.mock("./AgentBlock", async () => {
  const actual = await vi.importActual<typeof import("./AgentBlock")>("./AgentBlock");
  return {
    ...actual,
    AgentBlock: ({ block }: { block: AgentBlockData }) => {
      blockRenderCounts.set(block.id, (blockRenderCounts.get(block.id) ?? 0) + 1);
      return <div data-testid={`block-${block.id}`}>{block.content}</div>;
    },
  };
});

function makeBlock(
  id: string,
  content: string,
  type: AgentBlockData["type"] = "text",
): AgentBlockData {
  return { id, type, content };
}

describe("AgentStream", () => {
  beforeEach(() => {
    blockRenderCounts.clear();
    virtuosoState.firstItemIndex = undefined;
    virtuosoState.customScrollParent = undefined;
    virtuosoState.hasScrollerRef = false;
    virtuosoState.startReached = undefined;
    virtuosoState.rangeChanged = undefined;
  });

  it("renders blocks", () => {
    render(<AgentStream blocks={[makeBlock("1", "Hello"), makeBlock("2", "World")]} />);
    expect(screen.getByTestId("block-1")).toBeInTheDocument();
    expect(screen.getByTestId("block-2")).toBeInTheDocument();
  });

  it("renders empty stream without crashing", () => {
    const { container } = render(<AgentStream blocks={[]} />);
    expect(container).toBeInTheDocument();
  });

  it("shows streaming cursor when a turn is active", () => {
    render(
      <AgentStream
        blocks={[makeBlock("1", "Some output", "tool_call")]}
        isStreaming
        lifecycle={{ phase: "active" }}
      />,
    );
    expect(screen.getByText("█")).toBeInTheDocument();
  });

  it("shows cursor when active with no blocks", () => {
    render(<AgentStream blocks={[]} isStreaming lifecycle={{ phase: "active" }} />);
    expect(screen.getByText("█")).toBeInTheDocument();
  });

  it("hides streaming cursor when disabled", () => {
    render(
      <AgentStream
        blocks={[]}
        isStreaming
        lifecycle={{ phase: "active" }}
        showStreamingIndicator={false}
      />,
    );
    expect(screen.queryByText("█")).not.toBeInTheDocument();
  });

  it("renders sender and timestamp header for text blocks", () => {
    const block: AgentBlockData = {
      ...makeBlock("1", "Hello"),
      createdAt: "2026-02-22T10:30:00Z",
      model: "claude-sonnet-4-6",
    };
    render(<AgentStream blocks={[block]} />);
    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();
  });

  it("renders 'User' header for user_message blocks", () => {
    const block: AgentBlockData = {
      ...makeBlock("1", "Hi there", "user_message"),
      createdAt: "2026-02-22T10:30:00Z",
    };
    render(<AgentStream blocks={[block]} />);
    expect(screen.getByText("User")).toBeInTheDocument();
  });

  it("suppresses the user header for session replies", () => {
    const block: AgentBlockData = {
      ...makeBlock(
        "1",
        '<cadencr-reply from-session="3291" from-feature="1780" from-feature-title="QA reply routing" from-project="6" status="completed" link="spawned" request-message-id="1959337">\nREPLY_ROUTING_SUCCESS\n</cadencr-reply>',
        "user_message",
      ),
      createdAt: "2026-07-11T06:38:00Z",
      origin: { originKind: "session_generated", sourceSessionId: 3291 },
    };

    render(<AgentStream blocks={[block]} />);

    expect(screen.queryByText("User")).toBeNull();
  });

  it("renders 'unknown' when model is not set", () => {
    const block: AgentBlockData = {
      ...makeBlock("1", "Hello"),
      createdAt: "2026-02-22T10:30:00Z",
    };
    render(<AgentStream blocks={[block]} />);
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("does not show streaming indicator when not streaming", () => {
    render(<AgentStream blocks={[makeBlock("1", "Done output")]} isStreaming={false} />);
    expect(screen.queryByText(/\.\.\./)).not.toBeInTheDocument();
  });

  it("filters out blocks with parentToolUseId", () => {
    const parentBlock = makeBlock("1", "Parent");
    const childBlock: AgentBlockData = {
      ...makeBlock("2", "Child"),
      parentToolUseId: "parent-id",
    };
    render(<AgentStream blocks={[parentBlock, childBlock]} />);
    expect(screen.getByTestId("block-1")).toBeInTheDocument();
    expect(screen.queryByTestId("block-2")).not.toBeInTheDocument();
  });

  it("filters hidden blocks without merging neighboring visible rows", () => {
    const createdAt = "2026-04-12T12:09:36Z";
    const blocks: AgentBlockData[] = [
      { ...makeBlock("1", "Hello "), createdAt, model: "openai/gpt-5.3-codex" },
      { ...makeBlock("2", "ignored", "tool_result"), sourceToolName: "Read" },
      { ...makeBlock("3", "world"), createdAt, model: "openai/gpt-5.3-codex" },
    ];
    render(<AgentStream blocks={blocks} />);
    expect(screen.getByTestId("block-1")).toHaveTextContent("Hello");
    expect(screen.queryByTestId("block-2")).not.toBeInTheDocument();
    expect(screen.getByTestId("block-3")).toHaveTextContent("world");
  });

  it("does not coalesce text blocks from different timestamps", () => {
    const blocks: AgentBlockData[] = [
      {
        ...makeBlock("1", "First"),
        createdAt: "2026-04-12T12:09:36Z",
        model: "openai/gpt-5.3-codex",
      },
      {
        ...makeBlock("2", "Second"),
        createdAt: "2026-04-12T12:10:01Z",
        model: "openai/gpt-5.3-codex",
      },
    ];

    render(<AgentStream blocks={blocks} />);

    expect(screen.getByTestId("block-1")).toBeInTheDocument();
    expect(screen.getByTestId("block-2")).toBeInTheDocument();
  });

  it("renders the loading-older spinner above the list when isLoadingOlder is true", () => {
    const { container } = render(<AgentStream blocks={[makeBlock("1", "Hello")]} isLoadingOlder />);
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("decrements Virtuoso firstItemIndex by the prepended display-row offset", () => {
    render(
      <AgentStream
        blocks={[makeBlock("1", "Hello"), makeBlock("2", "World")]}
        historyPrependDisplayOffset={37}
      />,
    );

    expect(virtuosoState.firstItemIndex).toBe(999_963);
  });

  it("lets Virtuoso own the scroller and uses startReached for top pagination", () => {
    const onStartReached = vi.fn();

    render(<AgentStream blocks={[makeBlock("1", "Hello")]} onStartReached={onStartReached} />);

    expect(virtuosoState.customScrollParent).toBeUndefined();
    expect(virtuosoState.hasScrollerRef).toBe(true);
    virtuosoState.startReached?.();
    expect(onStartReached).toHaveBeenCalledTimes(1);
  });

  it("prefetches older history before the viewport reaches the exact first row", () => {
    const onStartReached = vi.fn();

    render(<AgentStream blocks={[makeBlock("1", "Hello")]} onStartReached={onStartReached} />);

    virtuosoState.rangeChanged?.({ startIndex: 1_000_015, endIndex: 1_000_020 });
    expect(onStartReached).not.toHaveBeenCalled();

    virtuosoState.rangeChanged?.({ startIndex: 1_000_012, endIndex: 1_000_017 });
    expect(onStartReached).toHaveBeenCalledTimes(1);
  });

  it("does not re-render unchanged AgentStreamItem blocks during streaming", () => {
    const block1 = makeBlock("1", "First");
    const block2 = makeBlock("2", "Second");
    const block3 = makeBlock("3", "Third");

    const { rerender } = render(<AgentStream blocks={[block1, block2, block3]} isStreaming />);

    expect(blockRenderCounts.get("1")).toBe(1);
    expect(blockRenderCounts.get("2")).toBe(1);
    expect(blockRenderCounts.get("3")).toBe(1);

    // Simulate a streaming chunk: only block 3 grows. Blocks 1 and 2 keep
    // their original references so their AgentStreamItem props are stable.
    const block3Updated: AgentBlockData = { ...block3, content: "Third — more" };
    rerender(<AgentStream blocks={[block1, block2, block3Updated]} isStreaming />);

    expect(blockRenderCounts.get("1")).toBe(1);
    expect(blockRenderCounts.get("2")).toBe(1);
    expect(blockRenderCounts.get("3")).toBe(2);
  });
});

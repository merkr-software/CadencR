import { describe, expect, it, vi } from "vitest";
import { act, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test-utils";
import type { AgentBlockData } from "@/types/agent-block";
import { getListFeatureSubagentsQueryKey, type SubagentRun } from "@/api/generated";
import { AgentSessionProvider } from "@/components/agent-session/agent-session-context";

vi.mock("@/components/SubagentActionRow", () => ({
  SubagentActionRow: ({ block, expanded }: { block: AgentBlockData; expanded?: boolean }) => (
    <div data-testid="action" data-expanded={expanded ? "true" : "false"}>
      {block.id}
    </div>
  ),
}));
vi.mock("@/components/Markdown", () => ({
  Markdown: ({ content }: { content: string }) => <div data-testid="report">{content}</div>,
}));

const { TaskAgentBlock } = await import("./TaskAgentBlock");

function readCall(id: string, path: string): AgentBlockData {
  return {
    id,
    type: "tool_call",
    content: "",
    toolName: "Read",
    toolArgs: JSON.stringify({ file_path: path }),
  };
}

function taskBlock(childCount: number, taskComplete = false): AgentBlockData {
  return {
    id: "task-1",
    type: "tool_call",
    content: "{}",
    toolName: "Task",
    toolUseId: "toolu_task",
    toolArgs: JSON.stringify({ description: "sub" }),
    taskComplete,
    childBlocks: Array.from({ length: childCount }, (_, i) => ({
      id: `child-${i}`,
      type: "text" as const,
      content: `step ${i}`,
    })),
  };
}

function run(overrides: Partial<SubagentRun>): SubagentRun {
  return {
    sessionId: 1,
    toolUseId: "toolu_task",
    status: "running",
    modelResolved: false,
    background: false,
    startedAt: "2026-10-30T10:00:00.000Z",
    ...overrides,
  };
}

describe("TaskAgentBlock", () => {
  it("shows a running sub-agent's latest action on one line, every action once opened", () => {
    const block = taskBlock(12);
    block.childBlocks = [
      ...(block.childBlocks ?? []),
      readCall("read-1", "src/first.ts"),
      readCall("read-2", "src/latest.ts"),
    ];
    render(<TaskAgentBlock block={block} />);
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("sub")).toBeInTheDocument();
    expect(screen.queryAllByTestId("action")).toHaveLength(0);
    expect(screen.getByText("src/latest.ts")).toBeInTheDocument();
    expect(screen.queryByText("src/first.ts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /expand sub-agent actions/i }));

    expect(screen.getAllByTestId("action")).toHaveLength(14);
    expect(screen.queryByText("src/latest.ts")).toBeNull();
  });

  it("keeps a finished sub-agent's last action above its report head", () => {
    const block = taskBlock(12, true);
    block.childBlocks = [readCall("read-1", "src/last.ts"), ...(block.childBlocks ?? [])];
    render(<TaskAgentBlock block={block} />);
    expect(screen.queryAllByTestId("action")).toHaveLength(0);
    expect(screen.getByText("src/last.ts")).toBeInTheDocument();
    expect(screen.getByTestId("report")).toHaveTextContent("step 11");

    fireEvent.click(screen.getByRole("button", { name: /expand sub-agent actions/i }));

    expect(screen.getAllByTestId("action")).toHaveLength(13);
  });

  it("is one bordered card", () => {
    const { container } = render(<TaskAgentBlock block={taskBlock(2)} />);
    const card = container.querySelector("[data-tool-family='task']");
    expect(card?.className).toMatch(/\bborder\b/);
    expect(card?.className).toMatch(/rounded-md/);
    expect(card?.className).toMatch(/block-task-bg/);
  });

  it("nests a Task/Agent child as another card at greater depth", () => {
    const nested: AgentBlockData = {
      id: "outer",
      type: "tool_call",
      content: "{}",
      toolName: "Agent",
      toolArgs: JSON.stringify({ description: "outer" }),
      childBlocks: [
        {
          id: "inner",
          type: "tool_call",
          content: "{}",
          toolName: "Task",
          toolArgs: JSON.stringify({ description: "inner" }),
          childBlocks: [{ id: "leaf", type: "text", content: "done" }],
        },
      ],
    };
    const { container } = render(<TaskAgentBlock block={nested} />);
    fireEvent.click(screen.getAllByRole("button", { name: /expand sub-agent actions/i })[0]);
    expect(screen.getByText("outer")).toBeInTheDocument();
    expect(screen.getByText("inner")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /expand sub-agent actions/i })[0]);
    expect(screen.getByText("leaf")).toBeInTheDocument();
    const depths = [...container.querySelectorAll("[data-subagent-depth]")].map((el) =>
      el.getAttribute("data-subagent-depth"),
    );
    expect(depths).toEqual(["0", "1"]);
  });

  it("retains header focus when expansion switches to the virtualized timeline", () => {
    render(<TaskAgentBlock block={taskBlock(100, true)} />);
    const toggle = screen.getByRole("button", { name: "Expand sub-agent actions" });
    toggle.focus();

    fireEvent.click(toggle);

    expect(toggle).toHaveFocus();
    expect(screen.getByTestId("subagent-action-timeline")).toBeInTheDocument();
  });

  it("compact flow keeps the facts and latest action but not the report head", () => {
    const block = taskBlock(4, true);
    block.childBlocks = [readCall("read-1", "src/last.ts"), ...(block.childBlocks ?? [])];
    render(<TaskAgentBlock block={block} compact />);
    expect(screen.getByText("src/last.ts")).toBeInTheDocument();
    expect(screen.queryByTestId("report")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /expand sub-agent actions/i }));
    expect(screen.getAllByTestId("action")).toHaveLength(5);
    expect(screen.getByTestId("report")).toHaveTextContent("step 3");
  });
});

describe("TaskAgentBlock with the sub-agent registry", () => {
  function renderWithRun(initial: SubagentRun, block = taskBlock(3)) {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(getListFeatureSubagentsQueryKey(9), [initial]);
    const context = {
      wsSessionId: "ws-feature-9",
      featureId: 9,
      sendPrompt: vi.fn(),
      openModelPicker: vi.fn(),
    };
    const view = render(
      <AgentSessionProvider value={context}>
        <TaskAgentBlock block={block} />
      </AgentSessionProvider>,
      { queryClient },
    );
    return { queryClient, ...view };
  }

  it("shows the agent's configuration from its run", () => {
    renderWithRun(
      run({
        agentType: "Explore",
        description: "Audit the adapter",
        model: "claude-haiku-5-5",
        modelResolved: true,
        reasoningEffort: "high",
        background: true,
        totalTokens: 18_200,
      }),
    );
    expect(screen.getByText("Explore")).toBeInTheDocument();
    expect(screen.getByText("Audit the adapter")).toBeInTheDocument();
    expect(screen.getByText("claude-haiku-5-5")).toBeInTheDocument();
    expect(screen.getByText("high effort")).toBeInTheDocument();
    expect(screen.getByText("background")).toBeInTheDocument();
    expect(screen.getByText(/18\.2K tok/)).toBeInTheDocument();
  });

  it("stops spinning the moment the registry says it finished", async () => {
    const { queryClient, container } = renderWithRun(run({}));
    const card = () => container.querySelector("[data-tool-family='task']");
    expect(card()).toHaveAttribute("data-subagent-status", "running");
    expect(container.querySelector(".sidebar-status-working")).not.toBeNull();

    act(() => {
      queryClient.setQueryData(getListFeatureSubagentsQueryKey(9), [
        run({ status: "completed", endedAt: "2026-10-30T10:00:42.000Z", durationMs: 42_000 }),
      ]);
    });

    await waitFor(() => expect(card()).toHaveAttribute("data-subagent-status", "completed"));
    expect(container.querySelector(".sidebar-status-working")).toBeNull();
    expect(screen.getByText("0:42")).toBeInTheDocument();
  });

  it("marks a failed run with its reason", () => {
    const { container } = renderWithRun(
      run({ status: "failed", statusReason: "Rate limited", endedAt: "2026-10-30T10:01:00Z" }),
    );
    expect(container.querySelector("[data-tool-family='task']")).toHaveAttribute(
      "data-subagent-status",
      "failed",
    );
    expect(screen.getByText("Failed · Rate limited")).toBeInTheDocument();
  });
});

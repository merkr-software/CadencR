import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@/test-utils";
import { AgentSession } from "./AgentSession";
import type { AgentBlockData } from "../AgentBlock";
import type { TurnTimingState } from "@/stores/ws-turn-timing";
import type { ContextUsageState } from "@/types/agent";

vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkeys: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useGetFeatureWorkingDir: vi.fn(() => ({ data: null })),
  useGetWorkspaceSetting: vi.fn(() => ({ data: { value: null } })),
}));

vi.mock("@/api/agentRuntime", () => ({
  DEFAULT_CLAUDE_PROFILE_NAME: "default",
  useAgentCatalog: vi.fn(() => ({
    data: {
      default_provider: "claude_code",
      providers: [
        {
          id: "claude_code",
          label: "Claude",
          status: "available",
          models: [{ id: "opus", label: "Opus" }],
          default_model: "opus",
        },
      ],
    },
    isLoading: false,
  })),
  useClaudeCodeProfiles: vi.fn(() => ({
    data: { active: "default", profiles: [{ name: "bedrock", env: {} }] },
    isLoading: false,
    isError: false,
  })),
}));

vi.mock("@/hooks/usePromptDraft", () => ({
  usePromptDraft: vi.fn(() => ({ saveDraft: vi.fn() })),
}));

vi.mock("@/hooks/usePromptHistory", () => ({
  usePromptHistory: vi.fn(() => ({
    addEntry: vi.fn(),
    history: [],
    navigateUp: vi.fn(),
    navigateDown: vi.fn(),
    reset: vi.fn(),
    resetNavigation: vi.fn(),
  })),
}));

vi.mock("@/hooks/useFileMention", () => ({
  useFileMention: vi.fn(() => ({
    open: false,
    query: "",
    filteredFiles: [],
    selectedIndex: 0,
    handleKeyDown: vi.fn(),
    handleChange: vi.fn(),
    selectFile: vi.fn(),
    triggerMention: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("@/hooks/useSlashCommand", () => ({
  useSlashCommand: vi.fn(() => ({
    open: false,
    query: "",
    filteredCommands: [],
    selectedIndex: 0,
    handleKeyDown: vi.fn(),
    handleChange: vi.fn(),
    selectCommand: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("@/hooks/useImageAttachments", () => ({
  useImageAttachments: vi.fn(() => ({
    attachments: [],
    addFiles: vi.fn(),
    removeAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    dragHandlers: {},
    isDragging: false,
  })),
}));

function turnTiming(startedAt: number): TurnTimingState {
  return {
    startedAt,
    segmentStartedAt: startedAt,
    activeMs: 0,
    userPendingMs: 0,
    completed: null,
  };
}

function makeUsage(): ContextUsageState {
  return {
    inputTokens: 25_000,
    outputTokens: 25_000,
    contextWindow: 100_000,
    wasCompacted: false,
  };
}

function makeBlock(id: string, content: string): AgentBlockData {
  return { id, type: "text", content };
}

describe("AgentSession canonical running state", () => {
  const onSend = vi.fn();
  const onStop = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    onSend.mockClear();
    onStop.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not show working timer or usage glow when live status is idle even if lifecycle is stale-active", () => {
    const { container } = render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="idle"
        lifecycle={{ phase: "active" }}
        turnTiming={turnTiming(5_000)}
        contextUsage={makeUsage()}
        onSend={onSend}
        onStop={onStop}
        collapsible
      />,
    );

    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.queryByText(/Working/)).not.toBeInTheDocument();
    expect(container.querySelector(".context-usage-glow")).not.toBeInTheDocument();
  });

  it("shows awaiting input without usage glow when live status is question", () => {
    const { container } = render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Need input")]}
        status="question"
        lifecycle={{ phase: "paused", reason: "question" }}
        turnTiming={turnTiming(5_000)}
        contextUsage={makeUsage()}
        onSend={onSend}
        onStop={onStop}
        collapsible
      />,
    );

    expect(screen.getByText("Awaiting input")).toBeInTheDocument();
    expect(screen.queryByText(/Working/)).not.toBeInTheDocument();
    expect(container.querySelector(".context-usage-glow")).not.toBeInTheDocument();
  });

  it("shows working timer and usage glow when live status is agent", () => {
    const { container } = render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Streaming output")]}
        status="agent"
        lifecycle={{ phase: "active" }}
        turnTiming={turnTiming(5_000)}
        contextUsage={makeUsage()}
        onSend={onSend}
        onStop={onStop}
        collapsible
      />,
    );

    expect(screen.getAllByText("Working - 5s").length).toBeGreaterThan(0);
    expect(container.querySelector(".context-usage-glow")).toBeInTheDocument();
  });

  it("shows a distinct Compacting badge while a manual compact is in progress", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Streaming output")]}
        status="agent"
        isCompacting
        lifecycle={{ phase: "active" }}
        turnTiming={turnTiming(5_000)}
        contextUsage={makeUsage()}
        onSend={onSend}
        onStop={onStop}
        collapsible
      />,
    );

    // Compaction takes precedence over the generic working badge AND the
    // in-stream progress cursor so the wait is never mistaken for an ordinary
    // slow/hung turn (issue #60).
    expect(screen.getAllByText("Compacting…").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Working/)).not.toBeInTheDocument();
  });

  it("shows Compacting in the full-height stream cursor while compaction is in progress", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="agent"
        isCompacting
        lifecycle={{ phase: "active" }}
        turnTiming={turnTiming(5_000)}
        contextUsage={makeUsage()}
        onSend={onSend}
        onStop={onStop}
      />,
    );

    expect(screen.getByText("Compacting…")).toBeInTheDocument();
    expect(screen.getByText("█")).toBeInTheDocument();
    expect(screen.queryByText(/Working/)).not.toBeInTheDocument();
  });

  it("does not show the Compacting badge once compaction completes", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Streaming output")]}
        status="agent"
        isCompacting={false}
        lifecycle={{ phase: "active" }}
        turnTiming={turnTiming(5_000)}
        contextUsage={makeUsage()}
        onSend={onSend}
        onStop={onStop}
        collapsible
      />,
    );

    expect(screen.queryByText("Compacting…")).not.toBeInTheDocument();
    expect(screen.getAllByText("Working - 5s").length).toBeGreaterThan(0);
  });
});

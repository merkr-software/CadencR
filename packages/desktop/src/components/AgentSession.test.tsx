import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@/test-utils";
import userEvent from "@testing-library/user-event";
import { AgentSession, shallowEqualSkipFunctions } from "./agent-session";
import type { AgentSessionProps } from "./agent-session";
import type { AgentBlockData } from "./AgentBlock";

// Mock Virtuoso so JSDOM tests render all items synchronously instead of
// relying on layout/IntersectionObserver. We don't need true virtualization
// here — the assertions check that block content is reachable in the DOM.
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
    components,
    context,
  }: {
    data?: AgentBlockData[];
    itemContent?: (index: number, block: AgentBlockData, context: unknown) => ReactNode;
    components?: {
      Header?: () => ReactNode;
      Footer?: (props: { context?: unknown }) => ReactNode;
    };
    context?: unknown;
  }) => (
    <div data-testid="virtuoso-mock">
      {components?.Header ? <components.Header /> : null}
      {data?.map((item, i) => (
        <div key={item.id}>{itemContent?.(i, item, context)}</div>
      ))}
      {components?.Footer ? <components.Footer context={context} /> : null}
    </div>
  ),
}));

const hotkeyHandlers = new Map<string, (event: KeyboardEvent) => void>();

vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkeys: vi.fn(
    (definitions: Array<{ callback: (event: KeyboardEvent) => void; hotkey: string }>) => {
      definitions.forEach((definition) => {
        hotkeyHandlers.set(definition.hotkey, definition.callback);
      });
    },
  ),
}));

vi.mock("../api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/generated")>()),
  useGetFeatureWorkingDir: vi.fn(() => ({ data: null })),
  useGetWorkspaceSetting: vi.fn(() => ({ data: { value: null } })),
}));

vi.mock("../api/agentRuntime", () => ({
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
        {
          id: "opencode",
          label: "OpenCode",
          status: "available",
          models: [],
          default_model: null,
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

// Mock hooks to avoid cascading tRPC dependencies
vi.mock("@/hooks/useBackgroundTasks", () => ({
  useBackgroundTasks: vi.fn(() => ({ tasks: [], activeCount: 0 })),
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

function makeBlock(id: string, content: string): AgentBlockData {
  return { id, type: "text", content };
}

describe("AgentSession", () => {
  const onSend = vi.fn();
  const onStop = vi.fn();

  beforeEach(async () => {
    const runtimeApi = await import("../api/agentRuntime");
    onSend.mockClear();
    onStop.mockClear();
    hotkeyHandlers.clear();
    vi.mocked(runtimeApi.useAgentCatalog).mockReturnValue({
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
          {
            id: "opencode",
            label: "OpenCode",
            status: "available",
            models: [],
            default_model: null,
          },
        ],
      },
      isLoading: false,
    } as ReturnType<typeof runtimeApi.useAgentCatalog>);
  });

  it("renders full-screen mode (collapsible=false)", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
      />,
    );
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("shows the new-session hint card when idle with no blocks", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
      />,
    );
    expect(screen.getByText("Start your first turn")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show another tip/i })).toBeInTheDocument();
  });

  it("shows cross-provider models before a session starts without standalone provider actions", async () => {
    const runtimeApi = await import("../api/agentRuntime");
    const catalog = {
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
          {
            id: "opencode",
            label: "OpenCode",
            status: "available",
            models: [{ id: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" }],
            default_model: "openai/gpt-5.3-codex",
          },
        ],
      },
      isLoading: false,
    } as ReturnType<typeof runtimeApi.useAgentCatalog>;
    vi.mocked(runtimeApi.useAgentCatalog).mockReturnValue(catalog);

    const user = userEvent.setup();
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        selection={{ providerId: "claude_code", modelId: "opus" }}
        runtimeProvider="claude_code"
      />,
    );

    await user.click(screen.getByRole("button", { name: /Opus/i }));

    expect(screen.getByRole("option", { name: "Opus" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "GPT-5.3 Codex" })).toBeInTheDocument();
    expect(screen.queryByText(/Use Claude Code/)).toBeNull();
    expect(screen.queryByText(/Use OpenCode/)).toBeNull();
  });

  it("opens the searchable model picker with Cmd+P", async () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        selection={{ providerId: "claude_code", modelId: "opus" }}
        runtimeProvider="claude_code"
      />,
    );

    await act(async () => {
      hotkeyHandlers.get("Mod+P")?.({
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent);
    });

    const searchInput = await screen.findByPlaceholderText("Search providers or models...");
    expect(searchInput).toBeInTheDocument();
    await waitFor(() => expect(searchInput).toHaveFocus());
  });

  it("locks the provider list once a session has history", async () => {
    const runtimeApi = await import("../api/agentRuntime");
    vi.mocked(runtimeApi.useAgentCatalog).mockReturnValueOnce({
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
          {
            id: "opencode",
            label: "OpenCode",
            status: "available",
            models: [{ id: "openai/gpt-5.3-codex", label: "GPT-5.3 Codex" }],
            default_model: "openai/gpt-5.3-codex",
          },
        ],
      },
      isLoading: false,
    } as ReturnType<typeof runtimeApi.useAgentCatalog>);

    const user = userEvent.setup();
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "hello")]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        selection={{ providerId: "claude_code", modelId: "opus" }}
        runtimeProvider="claude_code"
      />,
    );

    await user.click(screen.getByRole("button", { name: /Opus/i }));

    expect(screen.queryByText("OpenCode")).toBeNull();
    expect(screen.queryByText(/Use Claude Code/)).toBeNull();
    expect(screen.queryByText(/Use OpenCode/)).toBeNull();
  });

  it("renders blocks content", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Agent output text")]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
      />,
    );
    expect(screen.getByText("Agent output text")).toBeInTheDocument();
  });

  it("renders collapsible mode with header", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
        collapsible
      />,
    );
    expect(screen.getByText("Session")).toBeInTheDocument();
  });

  it("shows status badge - working", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="agent"
        lifecycle={{ phase: "active" }}
        turnTiming={{
          startedAt: Date.now() - 12_000,
          segmentStartedAt: Date.now() - 12_000,
          activeMs: 0,
          userPendingMs: 0,
          completed: null,
        }}
        onSend={onSend}
        onStop={onStop}
        collapsible
      />,
    );
    expect(screen.getAllByText("Working - 12s").length).toBeGreaterThan(0);
  });

  it("shows awaiting input instead of working duration while awaiting user input", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Need permission")]}
        status="question"
        lifecycle={{ phase: "paused", reason: "permission" }}
        turnTiming={{
          startedAt: Date.now() - 65_000,
          segmentStartedAt: Date.now() - 5_000,
          activeMs: 60_000,
          userPendingMs: 0,
          completed: null,
        }}
        onSend={onSend}
        onStop={onStop}
        collapsible
      />,
    );

    expect(screen.getByText("Awaiting input")).toBeInTheDocument();
    expect(screen.queryByText(/Working/)).not.toBeInTheDocument();
  });

  it("shows idle badge when status is idle", () => {
    // The 3-value enum collapses "completed"/"error"/"never started" into
    // a single Idle badge. The richer lifecycle distinction is handled
    // out-of-band via session.error envelopes / toasts.
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "done")]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
        collapsible
      />,
    );
    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it("shows awaiting input badge when status is question", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="question"
        onSend={onSend}
        onStop={onStop}
        collapsible
      />,
    );
    expect(screen.getByText("Awaiting input")).toBeInTheDocument();
  });

  it("uses custom label when provided", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
        collapsible
        label="Session 2"
      />,
    );
    expect(screen.getByText("Session 2")).toBeInTheDocument();
  });

  it("shows Resume button when resumable", () => {
    const onResume = vi.fn();
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
        collapsible
        resumable
        onResume={onResume}
      />,
    );
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
  });

  it("calls onResume when Resume clicked", async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
        collapsible
        resumable
        onResume={onResume}
      />,
    );
    await user.click(screen.getByRole("button", { name: /resume/i }));
    expect(onResume).toHaveBeenCalled();
  });

  it("does not show a review changes button when the agent has file changes", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
      />,
    );
    expect(screen.queryByText(/Review Changes/)).not.toBeInTheDocument();
  });

  it("shows todo list when todos provided", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="agent"
        onSend={onSend}
        onStop={onStop}
        todos={[
          {
            content: "Do the thing",
            activeForm: "Doing the thing",
            status: "in_progress",
          },
        ]}
      />,
    );
    expect(screen.getByText("0/1")).toBeInTheDocument();
  });

  it("does not open provider-only actions when a provider has no models", async () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
        onProviderChange={vi.fn()}
        onModelChange={vi.fn()}
        selection={{ providerId: "claude_code", modelId: "opus" }}
        runtimeProvider="claude_code"
      />,
    );

    await act(async () => {
      hotkeyHandlers.get("Mod+P")?.({
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent);
    });

    expect(
      screen.getByText((_, element) => element?.textContent === "OpenCode"),
    ).toBeInTheDocument();
    expect(screen.getByText("No models available")).toBeInTheDocument();
  });

  it("shows prompt bar for completed session agent when pendingPlanApproval is set", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Plan output")]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
        collapsible
        pendingPlanApproval={{ allowedPrompts: [] }}
        onPlanApprove={vi.fn()}
        onPlanRequestChanges={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
  });

  it("shows prompt bar for completed session agent when pendingPlanApproval is set", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "PRD output")]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
        collapsible
        pendingPlanApproval={{ allowedPrompts: [] }}
        onPlanApprove={vi.fn()}
        onPlanRequestChanges={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
  });

  it("hides prompt bar for completed session agent when NO pendingPlanApproval", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Plan output")]}
        status="idle"
        onSend={onSend}
        onStop={onStop}
        collapsible
      />,
    );
    expect(screen.queryByText("Plan ready for review")).toBeNull();
  });

  it("shows prompt bar when agent is paused with pendingPlanApproval", () => {
    render(
      <AgentSession
        agentType="session"
        blocks={[makeBlock("1", "Plan output")]}
        status="question"
        onSend={onSend}
        onStop={onStop}
        collapsible
        pendingPlanApproval={{ allowedPrompts: [] }}
        onPlanApprove={vi.fn()}
        onPlanRequestChanges={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
  });
});

describe("shallowEqualSkipFunctions", () => {
  const base: Partial<AgentSessionProps> = {
    agentType: "session",
    status: "agent",
    blocks: [],
    collapsible: true,
    featureId: 1,
    onSend: vi.fn(),
    onStop: vi.fn(),
  };

  it("returns true when data props are identical and functions differ", () => {
    const prev = {
      ...base,
      onSend: vi.fn(),
      onStop: vi.fn(),
    } as AgentSessionProps;
    const next = {
      ...base,
      onSend: vi.fn(),
      onStop: vi.fn(),
    } as AgentSessionProps;
    expect(shallowEqualSkipFunctions(prev, next)).toBe(true);
  });

  it("returns false when a data prop changes", () => {
    const prev = { ...base } as AgentSessionProps;
    const next = { ...base, status: "idle" as const } as AgentSessionProps;
    expect(shallowEqualSkipFunctions(prev, next)).toBe(false);
  });

  it("returns false when blocks reference changes", () => {
    const prev = { ...base, blocks: [] } as AgentSessionProps;
    const next = { ...base, blocks: [] } as AgentSessionProps;
    expect(shallowEqualSkipFunctions(prev, next)).toBe(false);
  });

  it("returns true when blocks reference is the same", () => {
    const blocks: AgentBlockData[] = [];
    const prev = { ...base, blocks } as AgentSessionProps;
    const next = { ...base, blocks } as AgentSessionProps;
    expect(shallowEqualSkipFunctions(prev, next)).toBe(true);
  });

  it("returns false when a data prop is removed", () => {
    const prev = { ...base, featureId: 1 } as AgentSessionProps;
    const next = { ...base } as AgentSessionProps;
    delete (next as unknown as Record<string, unknown>).featureId;
    expect(shallowEqualSkipFunctions(prev, next)).toBe(false);
  });
});

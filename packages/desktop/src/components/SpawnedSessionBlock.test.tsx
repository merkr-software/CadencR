import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import { AgentSessionProvider } from "@/components/agent-session/agent-session-context";
import { useSessionStatusStore } from "@/stores/session-status-store";
import type { LiveAgentStatus, PendingKind } from "@/types/agent";
import type { AgentBlockData } from "@/types/agent-block";
import { AgentBlock } from "./AgentBlock";

const navigate = vi.hoisted(() => vi.fn());
const digest = vi.hoisted(() => vi.fn());

const SPAWNED_FEATURE = {
  id: 2658,
  project_id: 3,
  title: "Review the DSN filing",
  runtime_provider: "codex_cli",
  model_session: "gpt-6.1-sol",
  thinking_effort: "xhigh",
};

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  getAgentActivityDigest: digest,
  // Only the spawned conversation exists: any other id reads as deleted.
  useGetFeature: (id: number) =>
    id === SPAWNED_FEATURE.id
      ? { data: SPAWNED_FEATURE, isLoading: false, isError: false, error: null }
      : { data: undefined, isLoading: false, isError: true, error: new Error("Feature not found") },
}));

const SPAWN_TOOL = "mcp__cadencr-project__project_spawn_session";
const PARENT_FEATURE = 1;

function spawnCall(): AgentBlockData {
  return {
    id: "spawn-call",
    type: "tool_call",
    content: "",
    toolName: SPAWN_TOOL,
    toolUseId: "toolu_spawn",
    toolArgs: JSON.stringify({ title: "Review", provider: "codex_cli", model: "gpt-6.1-sol" }),
  };
}

function spawnResult(text: string, isError = false): AgentBlockData {
  return {
    id: "spawn-result",
    type: "tool_result",
    content: JSON.stringify([{ type: "text", text }]),
    toolUseId: "toolu_spawn",
    isError,
  };
}

const SPAWNED = JSON.stringify({ featureId: 2658, sessionId: 4167, project: { id: 3 } });

function digestEntry(lastTool: { name: string; args: string } | null, lastReply: string | null) {
  return {
    entries: [
      {
        feature_id: 2658,
        feature_title: SPAWNED_FEATURE.title,
        project_id: 3,
        project_name: "epay",
        provider: "codex_cli",
        last_tool: lastTool,
        last_reply: lastReply,
      },
    ],
  };
}

function setStatus(
  sessionId: number,
  featureId: number,
  status: LiveAgentStatus,
  kind: PendingKind | null = null,
): void {
  act(() => {
    useSessionStatusStore.setState((state) => ({
      bySession: { ...state.bySession, [sessionId]: { featureId, status, kind, seq: 1 } },
    }));
  });
}

/** The card inside the parent's session, whose live status drives the pending states. */
function renderCard(result?: AgentBlockData): void {
  const toolResultMap = new Map(result ? [["toolu_spawn", result]] : []);
  const card: ReactElement = <AgentBlock block={spawnCall()} toolResultMap={toolResultMap} />;
  render(
    <AgentSessionProvider
      value={{
        wsSessionId: "ws-feature-1",
        featureId: PARENT_FEATURE,
        sendPrompt: () => {},
        openModelPicker: () => {},
      }}
    >
      {card}
    </AgentSessionProvider>,
  );
}

describe("spawned conversation card", () => {
  beforeEach(() => {
    navigate.mockReset();
    digest.mockReset();
    digest.mockResolvedValue(digestEntry(null, null));
    useSessionStatusStore.setState({ bySession: {} });
  });

  it("shows the spawned conversation's provider and model, and opens it", async () => {
    const user = userEvent.setup();
    renderCard(spawnResult(SPAWNED));

    expect(screen.getByText("Review the DSN filing")).toBeInTheDocument();
    expect(screen.getByText("gpt-6.1-sol")).toBeInTheDocument();
    expect(screen.getByText("xhigh effort")).toBeInTheDocument();
    expect(document.querySelector("[data-provider-mark]")).toHaveAttribute("aria-hidden", "true");

    await user.click(screen.getByRole("button", { name: /Open conversation Review the DSN/ }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/features/$featureId",
      params: { projectId: "3", featureId: "2658" },
    });
  });

  it("reads Codex's MCP result shape", () => {
    renderCard({
      ...spawnResult(""),
      content: JSON.stringify({ content: [{ type: "text", text: SPAWNED }], _meta: null }),
    });
    expect(screen.getByRole("button", { name: /Open conversation Review the DSN/ })).toBeEnabled();
  });

  it("names a permission the spawned agent waits on", () => {
    setStatus(4167, 2658, "question", "permission");
    renderCard(spawnResult(SPAWNED));
    expect(screen.getByRole("button", { name: /Needs approval/ })).toBeInTheDocument();
  });

  it("shows the spawned agent's latest action, then its reply once it stopped", async () => {
    digest.mockResolvedValue(
      digestEntry(
        { name: "Bash", args: JSON.stringify({ command: "pnpm test" }) },
        "Working on it",
      ),
    );
    setStatus(4167, 2658, "agent");
    renderCard(spawnResult(SPAWNED));

    expect(await screen.findByText("pnpm test")).toBeInTheDocument();
    expect(screen.queryByText("Working on it")).toBeNull();
    expect(digest).toHaveBeenCalledWith({ feature_ids: "2658" }, expect.anything());

    digest.mockResolvedValue(
      digestEntry({ name: "Bash", args: JSON.stringify({ command: "pnpm test" }) }, "All green."),
    );
    setStatus(4167, 2658, "idle");
    expect(await screen.findByText("All green.")).toBeInTheDocument();
  });

  it("does not open a spawned conversation that no longer loads", () => {
    renderCard(spawnResult(JSON.stringify({ featureId: 9999, project: { id: 3 } })));
    expect(screen.getByText("Conversation unavailable")).toHaveAttribute(
      "title",
      "Feature not found",
    );
    expect(screen.getByRole("button", { name: /Open conversation/ })).toBeDisabled();
  });

  it("explains a spawn that failed", () => {
    renderCard(spawnResult("Unknown provider", true));
    expect(screen.getByText("Could not start")).toBeInTheDocument();
    expect(screen.getByText("Unknown provider")).toHaveAttribute("title", "Unknown provider");
    expect(screen.queryByRole("button", { name: /Open conversation/ })).toBeNull();
  });

  it.each([
    ["agent", null, "Starting conversation"],
    ["question", "permission", "Needs approval"],
    ["idle", null, "Not started"],
  ] as const)("reads an unanswered call while the parent is %s", (status, kind, label) => {
    setStatus(1, PARENT_FEATURE, status, kind);
    renderCard();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("keeps provider sub-agents free of a provider mark", () => {
    render(
      <AgentBlock
        block={{
          id: "task",
          type: "tool_call",
          content: "",
          toolName: "Agent",
          toolUseId: "toolu_task",
          toolArgs: JSON.stringify({ subagent_type: "Explore", description: "Find it" }),
        }}
      />,
    );
    expect(document.querySelector("[data-subagent-id='toolu_task']")).not.toBeNull();
    expect(document.querySelector("[data-provider-mark]")).toBeNull();
  });
});

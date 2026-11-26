import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import type { AgentBlockData } from "@/types/agent-block";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry, WS_RECONNECTING_CODE } from "@/stores/ws-session-types";
import { AgentSessionProvider } from "./agent-session-context";
import { TranscriptMarker } from "./TranscriptMarker";

const SESSION = "ws-feature-1";

/** The marker as the live stream shows it: the newest block of a running session. */
function renderLatest(block: AgentBlockData) {
  useWsSessionStore.setState({
    sessions: { [SESSION]: { ...createSessionEntry(), blocks: [block] } },
  });
  const context = {
    wsSessionId: SESSION,
    featureId: 1,
    sendPrompt: vi.fn(),
    openModelPicker: vi.fn(),
  };
  render(
    <AgentSessionProvider value={context}>
      <TranscriptMarker block={block} />
    </AgentSessionProvider>,
  );
  return context;
}

afterEach(() => {
  useWsSessionStore.setState({ sessions: {} });
});

describe("TranscriptMarker", () => {
  it("shows a dropped connection as a reconnect notice, not a turn error", () => {
    renderLatest({
      id: "ws-err-close-1",
      type: "error",
      content: "Connection lost while streaming. Reconnecting…",
      errorCode: WS_RECONNECTING_CODE,
    });

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(
      "Reconnecting…The connection to Cadencr dropped. This conversation catches up once it is back.",
    );
    // A drop and a service restart look alike here: claim nothing about the agent.
    expect(notice).not.toHaveTextContent(/keeps working/);
    // Not a turn error: nothing to continue.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/ended its turn/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });

  it("names background work a restart stopped after the turn ended", () => {
    const context = renderLatest({
      id: "msg-12",
      type: "turn_interrupted",
      content: "restart_background",
    });

    const marker = screen.getByRole("note");
    expect(marker).toHaveAttribute("data-turn-interrupted", "background");
    expect(marker).toHaveTextContent("Background tasks stopped by a Cadencr restart");
    screen.getByRole("button", { name: "Resume" }).click();
    // Not the bare "continue": the agent's turn had ended normally.
    expect(context.sendPrompt).toHaveBeenCalledWith(
      expect.stringContaining("stopped the background work"),
    );
  });

  it("names a voluntary quit in the marker and manual resume prompt", () => {
    const context = renderLatest({
      id: "msg-13",
      type: "turn_interrupted",
      content: "quit_background",
    });
    expect(screen.getByRole("note")).toHaveTextContent(
      "Background tasks stopped when you quit Cadencr",
    );
    screen.getByRole("button", { name: "Resume" }).click();
    expect(context.sendPrompt).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("The user quit Cadencr, which stopped the background work"),
    );
  });

  it("still offers Continue on an error that ended the turn", () => {
    renderLatest({ id: "msg-9", type: "error", content: "boom", errorCode: "SDK_ERROR" });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The agent hit an error and ended its turn",
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });
});

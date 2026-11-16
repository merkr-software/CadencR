import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@/test-utils";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry } from "@/stores/ws-session-types";
import { AgentSessionStreamNotice } from "./AgentSessionStreamNotice";

describe("AgentSessionStreamNotice", () => {
  beforeEach(() => useWsSessionStore.setState({ sessions: {} }));

  it("shows the retry while the stream is degraded and hides it once recovered", () => {
    const session = createSessionEntry();
    useWsSessionStore.setState({ sessions: { s1: session } });
    render(<AgentSessionStreamNotice sessionId="s1" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    act(() =>
      useWsSessionStore.setState({
        sessions: {
          s1: {
            ...session,
            streamHealth: { state: "degraded", reason: "Codex is retrying: stream disconnected" },
          },
        },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting…");
    expect(screen.getByRole("status")).toHaveTextContent("Codex is retrying: stream disconnected");

    act(() =>
      useWsSessionStore.setState({
        sessions: { s1: { ...session, streamHealth: { state: "ok" } } },
      }),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

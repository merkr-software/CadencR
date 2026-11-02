import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@/test-utils";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry } from "@/stores/ws-session-types";
import { AgentSessionPersistenceNotice } from "./AgentSessionPersistenceNotice";

describe("AgentSessionPersistenceNotice", () => {
  beforeEach(() => useWsSessionStore.setState({ sessions: {} }));

  it("keeps the failed warning visible until confirmed recovery", () => {
    const session = createSessionEntry();
    session.persistenceStatus = { status: "degraded", message: "Saving will be retried." };
    useWsSessionStore.setState({ sessions: { s1: session } });
    render(<AgentSessionPersistenceNotice sessionId="s1" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Saving interrupted");
    act(() =>
      useWsSessionStore.setState({
        sessions: {
          s1: {
            ...session,
            persistenceStatus: { status: "failed", message: "Some output is unsaved." },
          },
        },
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Conversation history incomplete");
    expect(screen.getByRole("alert")).toHaveTextContent("Some output is unsaved.");
    act(() =>
      useWsSessionStore.setState({
        sessions: {
          s1: {
            ...session,
            persistenceStatus: { status: "recovered", message: "History saved." },
          },
        },
      }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not leak another session's warning", () => {
    const session = createSessionEntry();
    session.persistenceStatus = { status: "failed", message: "Unsaved output." };
    useWsSessionStore.setState({ sessions: { other: session } });
    render(<AgentSessionPersistenceNotice sessionId="s1" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

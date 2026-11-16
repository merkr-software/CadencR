import { afterEach, describe, expect, it } from "vitest";
import { busySessionTargets } from "./busy-session-targets";
import { useSessionStatusStore, type SessionStatusEntry } from "./session-status-store";
import { useWsSessionStore } from "./ws-session-store";
import { createSessionEntry } from "./ws-session-types";

function status(status: SessionStatusEntry["status"]): SessionStatusEntry {
  return { status, kind: null, featureId: 1, seq: 1 };
}

describe("busySessionTargets", () => {
  afterEach(() => {
    useSessionStatusStore.setState({ bySession: {} });
    useWsSessionStore.setState({ sessions: {} });
  });

  it("resolves backend-busy sessions to loaded conversations and lists the rest", () => {
    useSessionStatusStore.setState({
      bySession: {
        1: status("agent"),
        2: status("agent"),
        3: status("question"),
        4: status("idle"),
      },
    });
    useWsSessionStore.setState({
      sessions: {
        // Loaded here but its local lifecycle says idle: the backend wins.
        "tab-1": { ...createSessionEntry(), sessionDbId: 1, serverSessionId: "rt-1" },
        "tab-4": {
          ...createSessionEntry(),
          sessionDbId: 4,
          serverSessionId: "rt-4",
          lifecycle: { phase: "active" },
        },
      },
    });

    expect(busySessionTargets(new Set(["agent"]))).toEqual({ loaded: ["tab-1"], unreachable: [2] });
    expect(busySessionTargets(new Set(["agent", "question"]))).toEqual({
      loaded: ["tab-1"],
      unreachable: [2, 3],
    });
  });

  it("treats a loaded conversation without a runtime as unreachable", () => {
    useSessionStatusStore.setState({ bySession: { 1: status("agent") } });
    useWsSessionStore.setState({
      sessions: { "tab-1": { ...createSessionEntry(), sessionDbId: 1, serverSessionId: "" } },
    });

    expect(busySessionTargets(new Set(["agent"]))).toEqual({ loaded: [], unreachable: [1] });
  });
});

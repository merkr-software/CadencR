import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry } from "@/stores/ws-session-types";
import { QueuedSettingsHint, queuedSettingsMessage } from "./QueuedSettingsHint";

afterEach(() => {
  cleanup();
  useWsSessionStore.setState({ sessions: {} });
});

describe("queuedSettingsMessage", () => {
  it("names each waiting setting once", () => {
    expect(queuedSettingsMessage([])).toBeNull();
    expect(queuedSettingsMessage(["model.set"])).toBe(
      "Model change waits for the backend to reconnect.",
    );
    expect(
      queuedSettingsMessage([
        "runtime_overrides.set:thinking_effort",
        "runtime_overrides.set:model",
      ]),
    ).toBe("Thinking effort and model changes wait for the backend to reconnect.");
    expect(queuedSettingsMessage(["model.set", "effort.set", "mode.set"])).toBe(
      "Model, thinking effort and permission mode changes wait for the backend to reconnect.",
    );
  });
});

describe("QueuedSettingsHint", () => {
  it("shows a setting waiting for the reconnect, and nothing once it is sent", () => {
    useWsSessionStore.setState({
      sessions: { s1: { ...createSessionEntry(), queuedCommandActions: ["model.set"] } },
    });
    const { rerender } = render(<QueuedSettingsHint wsSessionId="s1" />);
    expect(screen.getByRole("status").textContent).toContain(
      "Model change waits for the backend to reconnect.",
    );

    useWsSessionStore.setState({
      sessions: { s1: { ...createSessionEntry(), pendingCommandActions: ["model.set"] } },
    });
    rerender(<QueuedSettingsHint wsSessionId="s1" />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

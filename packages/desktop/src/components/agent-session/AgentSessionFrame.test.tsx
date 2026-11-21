import { createRef } from "react";
import { Bot } from "lucide-react";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry, type SessionEntry } from "@/stores/ws-session-types";
import { AgentSessionFrame } from "./AgentSessionFrame";

const SESSION_ID = "ws-feature-1";

/** The full-page transcript (`collapsible` off), as a conversation workspace shows it. */
function renderTranscript({ isIdle }: { isIdle: boolean }) {
  return render(
    <AgentSessionFrame
      containerRef={createRef()}
      headerRef={createRef()}
      collapsible={false}
      isOpen
      isIdle={isIdle}
      status="idle"
      blocks={[]}
      streamContent={<p>the transcript</p>}
      bottomContent={<div>composer</div>}
      onToggle={() => {}}
      IconComponent={Bot}
      badge={{ label: "Idle", className: "" }}
      displayLabel="Agent"
      wsSessionId={SESSION_ID}
    />,
  );
}

function seedSession(patch: Partial<SessionEntry>): void {
  useWsSessionStore.setState({ sessions: { [SESSION_ID]: { ...createSessionEntry(), ...patch } } });
}

describe("the full-page transcript", () => {
  beforeEach(() => useWsSessionStore.setState({ sessions: {} }));

  it("says it is loading while the history has not arrived", () => {
    // No entry yet: the workspace creates it in its first effect.
    renderTranscript({ isIdle: true });

    expect(screen.getByRole("status", { name: "Loading conversation" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.queryByText("the transcript")).not.toBeInTheDocument();
    expect(screen.getByText("composer")).toBeInTheDocument();
  });

  it("shows the transcript once its history is in", () => {
    seedSession({ persistedLoaded: true });

    renderTranscript({ isIdle: false });

    expect(screen.getByText("the transcript")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading conversation" })).not.toBeInTheDocument();
  });

  it("shows why the history failed to load, not a loader", () => {
    seedSession({
      persistedLoaded: true,
      historyLoadFailure: { message: "database is locked", retrying: false },
    });

    renderTranscript({ isIdle: true });

    expect(screen.getByRole("alert")).toHaveTextContent("database is locked");
    expect(screen.queryByRole("status", { name: "Loading conversation" })).not.toBeInTheDocument();
  });
});

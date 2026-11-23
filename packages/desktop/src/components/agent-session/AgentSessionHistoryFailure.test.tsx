import { createRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentIcon } from "@/components/AgentIcon";
import { fireEvent, render, screen } from "@/test-utils";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { createSessionEntry } from "@/stores/ws-session-types";
import { AgentSessionFrame } from "./AgentSessionFrame";

function renderEmptyFrame(collapsible = false) {
  return render(
    <AgentSessionFrame
      containerRef={createRef()}
      headerRef={createRef()}
      collapsible={collapsible}
      isOpen
      isIdle
      status="idle"
      blocks={[]}
      streamContent={null}
      bottomContent={<div>composer</div>}
      onToggle={() => {}}
      IconComponent={AgentIcon}
      badge={{ label: "Idle", className: "" }}
      displayLabel="Agent"
      wsSessionId="s1"
    />,
  );
}

function seedFailure(retrying = false) {
  const session = createSessionEntry();
  session.persistedLoaded = true;
  session.historyLoadFailure = { message: "database is locked", retrying };
  useWsSessionStore.setState({ sessions: { s1: session } });
}

describe("AgentSessionHistoryFailure", () => {
  beforeEach(() => useWsSessionStore.setState({ sessions: {} }));

  it("replaces the empty-conversation hint with the failure and a retry", () => {
    seedFailure();
    renderEmptyFrame();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load this conversation's history");
    expect(alert).toHaveTextContent("database is locked");
    expect(screen.queryByText(/did you know/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    const session = useWsSessionStore.getState().sessions.s1;
    expect(session?.persistedLoaded).toBe(false);
    expect(session?.historyLoadFailure?.retrying).toBe(true);
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
  });

  it("says the failure instead of 'No output yet' in a collapsible card", () => {
    seedFailure();
    renderEmptyFrame(true);
    expect(screen.getByRole("alert")).toHaveTextContent("database is locked");
    expect(screen.queryByText("No output yet")).not.toBeInTheDocument();
  });

  it("keeps the usual empty state when the history loaded", () => {
    useWsSessionStore.setState({ sessions: { s1: createSessionEntry() } });
    renderEmptyFrame(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("No output yet")).toBeInTheDocument();
  });
});

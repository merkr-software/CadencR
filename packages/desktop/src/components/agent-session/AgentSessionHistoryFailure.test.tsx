import { createRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentIcon } from "@/components/AgentIcon";
import { uiI18n } from "@/lib/i18n/ui";
import { act, fireEvent, render, screen } from "@/test-utils";
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

  it("updates a stored history issue in place and preserves the focused retry button", async () => {
    useWsSessionStore.setState({ sessions: { s1: createSessionEntry() } });
    useWsSessionStore.getState().failPersistedLoad("s1", { issue: "missing" });
    renderEmptyFrame();
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    uiI18n.addResource("fr", "ui", "conversation.history.missing", "Historique indisponible");
    try {
      await act(() => uiI18n.changeLanguage("fr-CA"));
      expect(screen.getByRole("alert")).toHaveTextContent("Historique indisponible");
      expect(retry).toHaveFocus();
      await act(() => uiI18n.changeLanguage("en"));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The service didn't return this conversation's history.",
      );
      expect(retry).toHaveFocus();
    } finally {
      await act(() => uiI18n.changeLanguage("en"));
      uiI18n.removeResourceBundle("fr", "ui");
    }
  });

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

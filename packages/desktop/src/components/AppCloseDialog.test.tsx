import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import type { AppCloseState } from "@/hooks/useAppClose";
import { changeUiLanguage } from "@/shared/ui-i18n";
import { AppCloseDialog } from "./AppCloseDialog";

function state(quitting: boolean): AppCloseState {
  return {
    request: { id: 1, quitting },
    agents: [
      {
        session_id: 1,
        feature_id: 1,
        label: "Fix login",
        label_uses_fallback: false,
        waiting_on_you: false,
        background_only: true,
      },
      {
        session_id: 2,
        feature_id: 2,
        label: "Docs",
        label_uses_fallback: false,
        waiting_on_you: true,
        background_only: false,
      },
    ],
    cancel: vi.fn(),
    close: vi.fn(),
  };
}

describe("AppCloseDialog", () => {
  it("includes background work and offers one way to quit", async () => {
    const quit = state(true);
    render(<AppCloseDialog state={quit} />);

    expect(screen.getByText("Quit Cadencr?")).toBeInTheDocument();
    expect(
      screen.getByText(/Quitting stops active turns and the background work Cadencr manages/),
    ).toBeInTheDocument();
    expect(screen.getByText("Fix login").closest("li")).toHaveTextContent("background work");
    expect(screen.getByText("Docs").closest("li")).toHaveTextContent("waiting on you");
    expect(screen.queryByRole("button", { name: "Quit and resume on next launch" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Stop agents and quit" }));
    expect(quit.close).toHaveBeenCalledTimes(1);
  });

  it("closes only the window when the app keeps running", async () => {
    const close = state(false);
    render(<AppCloseDialog state={close} />);

    expect(screen.getByText("Close the window?")).toBeInTheDocument();
    expect(screen.getByText(/background work continue/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(close.close).toHaveBeenCalledTimes(1);
  });

  it("shows a failed work lookup while keeping the quit confirmable", () => {
    render(<AppCloseDialog state={{ ...state(true), agents: null }} />);
    expect(screen.getByText(/could not list the active agents/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop agents and quit" })).toBeEnabled();
  });

  it("translates the service fallback and preserves a conversation title with the same words", async () => {
    await changeUiLanguage("fr-FR");
    try {
      const quit = state(true);
      const agents =
        quit.agents?.map((agent) => ({
          ...agent,
          label: "Untitled conversation",
          label_uses_fallback: agent.session_id === 1,
        })) ?? null;
      render(<AppCloseDialog state={{ ...quit, agents }} />);

      expect(screen.getByText("Conversation sans titre")).toBeInTheDocument();
      expect(screen.getByText("Untitled conversation")).toBeInTheDocument();
    } finally {
      await act(async () => changeUiLanguage("en-US"));
    }
  });

  it("renders nothing without a pending close", () => {
    const { container } = render(<AppCloseDialog state={{ ...state(true), request: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

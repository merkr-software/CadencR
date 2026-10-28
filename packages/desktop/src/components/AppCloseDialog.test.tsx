import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import type { AppCloseState } from "@/hooks/useAppClose";
import { AppCloseDialog } from "./AppCloseDialog";

const resume = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/restart-resume-setting", () => ({
  useRestartResumeEnabled: () => ({
    enabled: resume.enabled,
    setEnabled: vi.fn(),
    isLoading: false,
  }),
}));

function state(quitting: boolean): AppCloseState {
  return {
    request: { quitting },
    agents: [
      { sessionId: 1, label: "Fix login", waitingOnYou: false },
      { sessionId: 2, label: "Docs", waitingOnYou: true },
    ],
    cancel: vi.fn(),
    close: vi.fn(),
  };
}

describe("AppCloseDialog", () => {
  beforeEach(() => {
    resume.enabled = true;
  });

  it("offers to resume the agents on the next launch, or to stop them", async () => {
    const quit = state(true);
    render(<AppCloseDialog state={quit} />);

    expect(screen.getByText("Quit Cadencr?")).toBeInTheDocument();
    expect(
      screen.getByText(/2 agents are still working\. Cadencr can pick them back up/),
    ).toBeInTheDocument();
    expect(screen.getByText("waiting on you")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Quit and resume on next launch" }));
    expect(quit.close).toHaveBeenCalledWith({ resumeAgents: true });
    await userEvent.click(screen.getByRole("button", { name: "Stop agents and quit" }));
    expect(quit.close).toHaveBeenCalledWith({ resumeAgents: false });
  });

  it("only stops the agents when resuming is turned off", async () => {
    resume.enabled = false;
    const quit = state(true);
    render(<AppCloseDialog state={quit} />);

    expect(screen.queryByRole("button", { name: "Quit and resume on next launch" })).toBeNull();
    expect(screen.getByText(/resuming agents after a restart is turned off/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop agents and quit" }));
    expect(quit.close).toHaveBeenCalledWith({ resumeAgents: false });
  });

  it("closes only the window when the app keeps running", async () => {
    const close = state(false);
    render(<AppCloseDialog state={close} />);

    expect(screen.getByText("Close the window?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop agents and quit" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(close.close).toHaveBeenCalledWith({ resumeAgents: true });
  });

  it("renders nothing without a pending close", () => {
    const { container } = render(<AppCloseDialog state={{ ...state(true), request: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

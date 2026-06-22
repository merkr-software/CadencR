import { describe, it, expect, vi } from "vitest";
import { act, render, screen, waitFor } from "@/test-utils";
import { WorktreeSetupSection } from "./WorktreeSetupSection";

const { mockGetSettings } = vi.hoisted(() => ({
  mockGetSettings: vi.fn<() => { data: unknown }>(() => ({ data: null })),
}));

vi.mock("@/api/generated", () => ({
  useGetFeatureSettings: mockGetSettings,
}));

function settingsArray(obj: Record<string, string>) {
  return Object.entries(obj).map(([key, value]) => ({ key, value }));
}

describe("WorktreeSetupSection", () => {
  it("renders nothing when no step is set", () => {
    mockGetSettings.mockReturnValue({ data: null });
    const { container } = render(<WorktreeSetupSection featureId={1} projectId={1} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders worktree setup section when step is present", () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "done",
        worktree_setup_log: "",
        worktree_setup_error: "",
        worktree_branch: "feature/my-branch",
      }),
    });
    render(<WorktreeSetupSection featureId={1} projectId={1} />);
    expect(screen.getByText("Worktree Setup")).toBeInTheDocument();
  });

  it("shows ready badge when step is done", () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "done",
        worktree_setup_log: "",
        worktree_setup_error: "",
        worktree_branch: "feature/test",
      }),
    });
    render(<WorktreeSetupSection featureId={1} projectId={1} />);
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("shows error badge when step is error", () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "error",
        worktree_setup_log: "",
        worktree_setup_error: "Setup failed",
        worktree_branch: "",
      }),
    });
    render(<WorktreeSetupSection featureId={1} projectId={1} />);
    expect(screen.getByText("error")).toBeInTheDocument();
  });

  it("keeps a persisted setup error collapsed on mount", () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "setup_error",
        worktree_setup_log: "fnm: command not found",
        worktree_setup_error: "Setup failed",
        worktree_branch: "feature/my-branch",
      }),
    });
    render(<WorktreeSetupSection featureId={1} projectId={1} />);
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.queryByText("Run setup commands")).not.toBeInTheDocument();
    expect(screen.queryByText("fnm: command not found")).not.toBeInTheDocument();
  });

  it("keeps a persisted setup error collapsed after settings load", () => {
    mockGetSettings.mockReturnValueOnce({ data: null }).mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "setup_error",
        worktree_setup_log: "fnm: command not found",
        worktree_setup_error: "Setup failed",
        worktree_branch: "feature/my-branch",
      }),
    });
    const { rerender } = render(<WorktreeSetupSection featureId={1} projectId={1} />);

    rerender(<WorktreeSetupSection featureId={1} projectId={1} />);

    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.queryByText("Run setup commands")).not.toBeInTheDocument();
    expect(screen.queryByText("fnm: command not found")).not.toBeInTheDocument();
  });

  it("auto-closes 5 seconds after setup transitions to done in this session", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Mount at "created" so the first observation is recorded; the
      // subsequent created → setup transition flips userToggle=true (auto-open),
      // and only the timer should re-close the section.
      const { rerender } = render(
        <WorktreeSetupSection
          featureId={1}
          projectId={1}
          wsWorktreeStatus="created"
          wsWorktreeBranch="feat/test"
          wsWorktreeSetupOutput={[]}
        />,
      );

      rerender(
        <WorktreeSetupSection
          featureId={1}
          projectId={1}
          wsWorktreeStatus="setup_running"
          wsWorktreeBranch="feat/test"
          wsWorktreeSetupOutput={["installing"]}
        />,
      );
      // Auto-opens on the created → setup transition
      expect(screen.getByText("Run setup commands")).toBeInTheDocument();

      rerender(
        <WorktreeSetupSection
          featureId={1}
          projectId={1}
          wsWorktreeStatus="ready"
          wsWorktreeBranch="feat/test"
          wsWorktreeSetupOutput={["installing", "done"]}
        />,
      );
      // Still open just after completion (userToggle was true from auto-open)
      expect(screen.getByText("Run setup commands")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      // Collapsed after the 5s delay
      expect(screen.queryByText("Run setup commands")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-close on error completion", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { rerender } = render(
        <WorktreeSetupSection
          featureId={1}
          projectId={1}
          wsWorktreeStatus="created"
          wsWorktreeBranch="feat/test"
          wsWorktreeSetupOutput={[]}
        />,
      );

      rerender(
        <WorktreeSetupSection
          featureId={1}
          projectId={1}
          wsWorktreeStatus="setup_running"
          wsWorktreeBranch="feat/test"
          wsWorktreeSetupOutput={["installing"]}
        />,
      );
      expect(screen.getByText("Run setup commands")).toBeInTheDocument();

      rerender(
        <WorktreeSetupSection
          featureId={1}
          projectId={1}
          wsWorktreeStatus="setup_error"
          wsWorktreeBranch="feat/test"
          wsWorktreeSetupOutput={["installing", "boom"]}
          wsWorktreeError="Setup failed"
        />,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });

      // Stays open on error so the user can read the failure
      expect(screen.getByText("Run setup commands")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-close when remounting on a 'done' state (old conversation)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Mount fresh with step already 'done' — simulates revisiting an old conversation.
      // The default behavior keeps the section collapsed; we must not toggle anything
      // that would change after 5s.
      mockGetSettings.mockReturnValue({
        data: settingsArray({
          worktree_setup_step: "done",
          worktree_setup_log: "",
          worktree_setup_error: "",
          worktree_branch: "feature/test",
        }),
      });
      render(<WorktreeSetupSection featureId={1} projectId={1} />);
      // Collapsed at mount
      expect(screen.queryByText("Run setup commands")).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      // Still collapsed — no spurious open/close cycle
      expect(screen.queryByText("Run setup commands")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens when a mounted worktree setup transitions to error", async () => {
    const { rerender } = render(
      <WorktreeSetupSection
        featureId={1}
        projectId={1}
        wsWorktreeStatus="ready"
        wsWorktreeBranch="feat/test"
        wsWorktreeSetupOutput={[]}
      />,
    );
    expect(screen.queryByText("Run setup commands")).not.toBeInTheDocument();

    rerender(
      <WorktreeSetupSection
        featureId={1}
        projectId={1}
        wsWorktreeStatus="setup_error"
        wsWorktreeBranch="feat/test"
        wsWorktreeSetupOutput={["pnpm install failed"]}
        wsWorktreeError="Command `pnpm install` exited with status 1"
      />,
    );

    await waitFor(() => expect(screen.getByText("Run setup commands")).toBeInTheDocument());
    expect(screen.getByText("Command `pnpm install` exited with status 1")).toBeInTheDocument();
  });

  it("renders setup log with terminal styling in ws mode", async () => {
    const { user } = render(
      <WorktreeSetupSection
        featureId={1}
        projectId={1}
        wsWorktreeStatus="ready"
        wsWorktreeBranch="feat/test"
        wsWorktreeSetupOutput={["installing deps", "all done"]}
      />,
    );
    await user.click(screen.getByText("Worktree Setup"));
    const logEl = screen.getByText(
      (_, el) => el?.tagName === "PRE" && el.textContent === "installing deps\nall done",
    );
    expect(screen.getByText("Setup — worktree commands")).toBeInTheDocument();
    expect(logEl.parentElement?.className).toContain("bg-[var(--block-bash-body-bg)]");
  });

  it("falls back to persisted setup log when ws resume has no output", async () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "ready",
        worktree_setup_log: "pnpm install\ncompleted",
        worktree_setup_error: "",
        worktree_branch: "feat/resume",
      }),
    });
    const { user } = render(
      <WorktreeSetupSection
        featureId={1}
        projectId={1}
        wsWorktreeStatus="ready"
        wsWorktreeBranch="feat/resume"
        wsWorktreeSetupOutput={[]}
      />,
    );
    await user.click(screen.getByText("Worktree Setup"));
    expect(
      screen.getByText(
        (_, el) => el?.tagName === "PRE" && el.textContent === "pnpm install\ncompleted",
      ),
    ).toBeInTheDocument();
  });

  it("maps DB 'ready' value to done badge (not running)", () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "ready",
        worktree_setup_log: "",
        worktree_setup_error: "",
        worktree_branch: "feature/ready-branch",
      }),
    });
    render(<WorktreeSetupSection featureId={1} projectId={1} />);
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.queryByText("running")).not.toBeInTheDocument();
  });

  it("maps DB 'setup_running' value to running badge", () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "setup_running",
        worktree_setup_log: "",
        worktree_setup_error: "",
        worktree_branch: "",
      }),
    });
    render(<WorktreeSetupSection featureId={1} projectId={1} />);
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("maps DB 'setup_error' value to error badge", () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "setup_error",
        worktree_setup_log: "",
        worktree_setup_error: "something broke",
        worktree_branch: "",
      }),
    });
    render(<WorktreeSetupSection featureId={1} projectId={1} />);
    expect(screen.getByText("error")).toBeInTheDocument();
  });

  it("shows error on 'Run setup commands' step when expanded after setup fails", async () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "setup_error",
        worktree_setup_log: "fnm: command not found",
        worktree_branch: "feature/my-branch",
      }),
    });
    const { user } = render(<WorktreeSetupSection featureId={1} projectId={1} />);
    await user.click(screen.getByText("Worktree Setup"));
    // Error should show on step 3, not step 2
    const steps = screen.getAllByText(/Define name|Create worktree|Run setup commands/);
    expect(steps).toHaveLength(3);
    // Log output should be visible
    expect(screen.getByText("fnm: command not found")).toBeInTheDocument();
  });

  it("expands on header click to show steps", async () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "done",
        worktree_setup_log: "",
        worktree_setup_error: "",
        worktree_branch: "feature/test",
      }),
    });
    const { user } = render(<WorktreeSetupSection featureId={1} projectId={1} />);
    await user.click(screen.getByText("Worktree Setup"));
    expect(screen.getByText("Define name")).toBeInTheDocument();
  });

  it("copies branch name from a dedicated header button without toggling the section", async () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "done",
        worktree_setup_log: "",
        worktree_setup_error: "",
        worktree_branch: "feature/add-one-dark-theme",
      }),
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    if (!navigator.clipboard) {
      Object.defineProperty(window.navigator, "clipboard", {
        value: { writeText },
        writable: true,
        configurable: true,
      });
    } else {
      vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
    }

    const { user } = render(<WorktreeSetupSection featureId={1} projectId={1} />);
    // Section is collapsed by default when done — steps should not be visible
    expect(screen.queryByText("Define name")).not.toBeInTheDocument();
    expect(screen.getByText("feature/add-one-dark-theme")).toHaveClass("text-muted-foreground");

    await user.click(screen.getByRole("button", { name: "Copy branch name" }));

    expect(writeText).toHaveBeenCalledWith("feature/add-one-dark-theme");
    expect(screen.getByRole("button", { name: "Copied branch name" })).toBeInTheDocument();
    // stopPropagation prevents expanding the collapsed section
    expect(screen.queryByText("Define name")).not.toBeInTheDocument();

    vi.restoreAllMocks();
  });
});

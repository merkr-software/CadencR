import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, render, screen, waitFor } from "@/test-utils";
import { WorktreeSetupSection } from "./WorktreeSetupSection";

const { mockGetSettings, mockListWorktrees } = vi.hoisted(() => ({
  mockGetSettings: vi.fn<() => { data: unknown }>(() => ({ data: null })),
  mockListWorktrees: vi.fn(() => ({
    data: [
      {
        feature_id: 1,
        worktree_path: "/repo/worktree",
        worktree_branch: "feature/test",
        is_default_branch: false,
        is_main_worktree: false,
        directory_exists: true,
        branch_exists: true,
        live: true,
      },
    ],
    isLoading: false,
    error: null,
  })),
}));

vi.mock("@/api/generated", () => ({
  useGetFeatureSettings: mockGetSettings,
  useListFeatureWorktrees: mockListWorktrees,
}));

function settingsArray(obj: Record<string, string>) {
  return Object.entries(obj).map(([key, value]) => ({ key, value }));
}

describe("WorktreeSetupSection", () => {
  beforeEach(() => {
    mockListWorktrees.mockReturnValue({
      data: [
        {
          feature_id: 1,
          worktree_path: "/repo/worktree",
          worktree_branch: "feature/test",
          is_default_branch: false,
          is_main_worktree: false,
          directory_exists: true,
          branch_exists: true,
          live: true,
        },
      ],
      isLoading: false,
      error: null,
    });
  });

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
    expect(screen.getByRole("button", { name: /worktree setup/i })).toBeInTheDocument();
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

  it("keeps removed-worktree details collapsed until the setup row is opened", async () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "done",
        worktree_branch: "feature/test",
      }),
    });
    mockListWorktrees.mockReturnValue({
      data: [
        {
          feature_id: 1,
          worktree_path: "/repo/missing",
          worktree_branch: "feature/test",
          is_default_branch: false,
          is_main_worktree: false,
          directory_exists: false,
          branch_exists: true,
          live: false,
        },
      ],
      isLoading: false,
      error: null,
    });

    render(<WorktreeSetupSection featureId={1} projectId={1} />);

    expect(screen.getByText("removed")).toBeInTheDocument();
    expect(screen.getByText("Folder removed; branch still exists")).toBeInTheDocument();
    expect(
      screen.queryByText(/Cadencr is using the project folder instead/i),
    ).not.toBeInTheDocument();

    await act(async () => screen.getByRole("button", { name: /worktree setup/i }).click());

    expect(screen.getByText(/Cadencr is using the project folder instead/i)).toBeInTheDocument();
  });

  it("reports details when both the worktree folder and branch were removed", async () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({ worktree_setup_step: "done", worktree_branch: "feature/test" }),
    });
    mockListWorktrees.mockReturnValue({
      data: [
        {
          feature_id: 1,
          worktree_path: "/repo/missing",
          worktree_branch: "feature/test",
          is_default_branch: false,
          is_main_worktree: false,
          directory_exists: false,
          branch_exists: false,
          live: false,
        },
      ],
      isLoading: false,
      error: null,
    });

    render(<WorktreeSetupSection featureId={1} projectId={1} />);

    expect(screen.getByText("Folder and branch removed")).toBeInTheDocument();
    expect(screen.queryByText(/was also removed/i)).not.toBeInTheDocument();

    await act(async () => screen.getByRole("button", { name: /worktree setup/i }).click());

    expect(screen.getByText(/was also removed/i)).toBeInTheDocument();
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

  it("exposes the full branch and the setup error as tooltips while collapsed", () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "setup_error",
        worktree_setup_log: "",
        worktree_setup_error: "Command `pnpm i` exited with status 1",
        worktree_branch: "feature/a-very-long-branch-name",
      }),
    });
    render(<WorktreeSetupSection featureId={1} projectId={1} />);
    expect(screen.getByRole("button", { name: /worktree setup/i })).toHaveAttribute(
      "title",
      "feature/a-very-long-branch-name",
    );
    expect(screen.getByTitle("Command `pnpm i` exited with status 1")).toHaveTextContent("error");
  });

  it("does not surface a stale setup error once the worktree is ready", () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({
        worktree_setup_step: "ready",
        worktree_setup_log: "",
        worktree_setup_error: "Old failure",
        worktree_branch: "feature/my-branch",
      }),
    });
    render(<WorktreeSetupSection featureId={1} projectId={1} />);
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(screen.queryByTitle("Old failure")).not.toBeInTheDocument();
  });

  it("reflects the disclosure state on the toggle button", async () => {
    mockGetSettings.mockReturnValue({
      data: settingsArray({ worktree_setup_step: "ready", worktree_branch: "feature/my-branch" }),
    });
    const { user } = render(<WorktreeSetupSection featureId={1} projectId={1} />);
    const toggle = screen.getByRole("button", { name: /worktree setup/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Define name")).toBeInTheDocument();
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

  it("keeps setup details collapsed while setup runs and completes", async () => {
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
      expect(screen.getByText("running")).toBeInTheDocument();
      expect(screen.queryByText("Run setup commands")).not.toBeInTheDocument();

      rerender(
        <WorktreeSetupSection
          featureId={1}
          projectId={1}
          wsWorktreeStatus="ready"
          wsWorktreeBranch="feat/test"
          wsWorktreeSetupOutput={["installing", "done"]}
        />,
      );
      expect(screen.getByText("ready")).toBeInTheDocument();
      expect(screen.queryByText("Run setup commands")).not.toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(screen.queryByText("Run setup commands")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-expands when setup transitions to error", async () => {
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
      expect(screen.getByText("running")).toBeInTheDocument();
      expect(screen.queryByText("Run setup commands")).not.toBeInTheDocument();

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
    await user.click(screen.getByRole("button", { name: /worktree setup/i }));
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
    await user.click(screen.getByRole("button", { name: /worktree setup/i }));
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
    await user.click(screen.getByRole("button", { name: /worktree setup/i }));
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
    await user.click(screen.getByRole("button", { name: /worktree setup/i }));
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
    expect(screen.getByRole("button", { name: /worktree setup/i })).toHaveClass(
      "text-muted-foreground",
    );

    await user.click(screen.getByRole("button", { name: "Copy branch name" }));

    expect(writeText).toHaveBeenCalledWith("feature/add-one-dark-theme");
    expect(screen.getByRole("button", { name: "Copied branch name" })).toBeInTheDocument();
    // stopPropagation prevents expanding the collapsed section
    expect(screen.queryByText("Define name")).not.toBeInTheDocument();

    vi.restoreAllMocks();
  });
});

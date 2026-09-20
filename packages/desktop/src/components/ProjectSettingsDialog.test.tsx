import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";

const generatedMocks = vi.hoisted(() => ({
  getProjectSettings: vi.fn(),
  getPublicationReadiness: vi.fn(),
  preparePublicationPackage: vi.fn(),
  setProjectSetting: vi.fn(),
}));

vi.mock("../api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/generated")>()),
  useGetProjectSettings: generatedMocks.getProjectSettings,
  useGetProjectPublicationReadiness: generatedMocks.getPublicationReadiness,
  usePreparePublicationPackage: vi.fn(() => ({
    error: null,
    isError: false,
    isPending: false,
    mutate: generatedMocks.preparePublicationPackage,
    reset: vi.fn(),
  })),
  useSetProjectSetting: vi.fn(() => ({ mutate: generatedMocks.setProjectSetting })),
  useListProjectWorktrees: vi.fn(() => ({ data: [] })),
}));

vi.mock("./ModelSelector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));

describe("ProjectSettingsDialog", () => {
  beforeEach(() => {
    generatedMocks.getProjectSettings.mockReturnValue({ data: [] });
    generatedMocks.getPublicationReadiness.mockReturnValue({
      data: undefined,
      isLoading: true,
      isRefetching: false,
      isError: false,
      refetch: vi.fn(),
    });
    generatedMocks.setProjectSetting.mockClear();
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <ProjectSettingsDialog
        projectId={1}
        projectName="My Project"
        open={false}
        onOpenChange={vi.fn()}
      />,
    );
    expect(container.querySelector("[role='dialog']")).not.toBeInTheDocument();
  });

  it("renders dialog title with project name when open", () => {
    render(
      <ProjectSettingsDialog
        projectId={1}
        projectName="My Project"
        open={true}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText("My Project")).toBeInTheDocument();
    expect(screen.getByText(/Project settings/i)).toBeInTheDocument();
  });

  it("renders branch prefix input", () => {
    render(
      <ProjectSettingsDialog projectId={1} projectName="Test" open={true} onOpenChange={vi.fn()} />,
    );
    expect(screen.getByPlaceholderText(/e.g. feature\//i)).toBeInTheDocument();
  });

  it("renders setup worktree label", () => {
    render(
      <ProjectSettingsDialog projectId={1} projectName="Test" open={true} onOpenChange={vi.fn()} />,
    );
    expect(screen.getByText("Worktree setup commands")).toBeInTheDocument();
  });

  it("renders setup worktree commands as a shell editor", () => {
    render(
      <ProjectSettingsDialog projectId={1} projectName="Test" open={true} onOpenChange={vi.fn()} />,
    );
    expect(screen.getByText("Shell")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/pnpm install/i)).toHaveClass("font-mono");
  });

  it("does not render removed autonomy, parallel, or QA settings", () => {
    render(
      <ProjectSettingsDialog projectId={1} projectName="Test" open={true} onOpenChange={vi.fn()} />,
    );
    expect(screen.queryByRole("radiogroup", { name: /agent autonomy/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Parallel agent execution/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/QA testing procedure/i)).not.toBeInTheDocument();
  });

  it("shows publication preparation only for an explicit provider authoring project", () => {
    const props = {
      projectId: 1,
      projectName: "Provider",
      authoringTarget: "provider" as const,
      open: true,
      onOpenChange: vi.fn(),
    };
    const { rerender } = render(<ProjectSettingsDialog {...props} />);

    expect(screen.getByText("Provider publication preparation")).toBeInTheDocument();
    expect(screen.getByText("Prepare a local provider bundle")).toBeInTheDocument();

    rerender(<ProjectSettingsDialog {...props} authoringTarget={undefined} />);

    expect(screen.queryByText("Provider publication preparation")).not.toBeInTheDocument();
    expect(screen.queryByText("Prepare a local provider bundle")).not.toBeInTheDocument();

    rerender(<ProjectSettingsDialog {...props} authoringTarget="theme" />);

    expect(screen.queryByText("Provider publication preparation")).not.toBeInTheDocument();
    expect(screen.queryByText("Prepare a local provider bundle")).not.toBeInTheDocument();
  });

  it("closes dialog when escape is pressed", async () => {
    const onOpenChange = vi.fn();
    const { user } = render(
      <ProjectSettingsDialog
        projectId={1}
        projectName="Test"
        open={true}
        onOpenChange={onOpenChange}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not replace in-progress setup command edits when settings load late", async () => {
    generatedMocks.getProjectSettings.mockReturnValue({ data: undefined });
    const props = {
      projectId: 1,
      projectName: "Test",
      open: true,
      onOpenChange: vi.fn(),
    };
    const { user, rerender } = render(<ProjectSettingsDialog {...props} />);
    const setupInput = screen.getByPlaceholderText(/pnpm install/i);

    await user.type(setupInput, "pnpm install");
    expect(setupInput).toHaveValue("pnpm install");

    generatedMocks.getProjectSettings.mockReturnValue({
      data: [{ key: "setup_worktree", value: "echo stale" }],
    });
    rerender(<ProjectSettingsDialog {...props} />);

    expect(screen.getByPlaceholderText(/pnpm install/i)).toHaveValue("pnpm install");
  });

  it("resets dirty setup command edits when switching projects", async () => {
    generatedMocks.getProjectSettings.mockImplementation((projectId: number) => ({
      data:
        projectId === 2
          ? [{ key: "setup_worktree", value: "pnpm install --frozen-lockfile" }]
          : [{ key: "setup_worktree", value: "pnpm install" }],
    }));
    const onOpenChange = vi.fn();
    const { user, rerender } = render(
      <ProjectSettingsDialog
        projectId={1}
        projectName="First"
        open={true}
        onOpenChange={onOpenChange}
      />,
    );
    const setupInput = screen.getByPlaceholderText(/pnpm install/i);

    await user.clear(setupInput);
    await user.type(setupInput, "local unsaved edit");
    expect(setupInput).toHaveValue("local unsaved edit");

    rerender(
      <ProjectSettingsDialog
        projectId={2}
        projectName="Second"
        open={true}
        onOpenChange={onOpenChange}
      />,
    );

    expect(screen.getByPlaceholderText(/pnpm install/i)).toHaveValue(
      "pnpm install --frozen-lockfile",
    );
  });
});

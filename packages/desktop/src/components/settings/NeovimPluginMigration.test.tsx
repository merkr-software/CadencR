import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, createTestQueryClient } from "@/test-utils";
import { getGetWorkspaceSettingQueryKey } from "@/api/generated";
import { NeovimPluginMigration } from "./NeovimPluginMigration";

const mocks = vi.hoisted(() => ({
  backend: null as string | null,
  vim: "2",
  status: {
    plugin: "ready",
    sessions_running: [] as number[],
    current_backend: null as string | null,
    target: "plugin:neovim",
  },
  statusLoading: false,
  mutateAsync: vi.fn(),
}));

vi.mock("@/api/generated", async (original) => ({
  ...(await original<typeof import("@/api/generated")>()),
  useGetWorkspaceSetting: (key: string) => ({
    data: { value: key === "editor_backend" ? mocks.backend : null },
  }),
  useMigrationStatusRoute: () => ({
    data: mocks.statusLoading ? undefined : mocks.status,
    isLoading: mocks.statusLoading,
  }),
  useMigrateToPluginRoute: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));

vi.mock("@/hooks/useVimModeLevel", () => ({
  useVimModeLevel: () => mocks.vim,
}));

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    search,
    children,
  }: {
    to: string;
    search?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={`${to}${search ? `?${new URLSearchParams(search).toString()}` : ""}`}>{children}</a>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.backend = null;
  mocks.vim = "2";
  mocks.statusLoading = false;
  mocks.status = {
    plugin: "ready",
    sessions_running: [],
    current_backend: null,
    target: "plugin:neovim",
  };
  mocks.mutateAsync.mockResolvedValue({ migrated: true, editor_backend: "plugin:neovim" });
});

describe("NeovimPluginMigration", () => {
  it("stays hidden when another editor is selected", () => {
    mocks.backend = "codemirror";
    const { container } = render(<NeovimPluginMigration />);
    expect(container).toBeEmptyDOMElement();
  });

  it("stays hidden when only CodeMirror vim motions are on", () => {
    mocks.backend = null;
    mocks.vim = "0";
    const { container } = render(<NeovimPluginMigration />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the switch on built-in full Neovim and migrates on click", async () => {
    const client = createTestQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { user } = render(<NeovimPluginMigration />, { queryClient: client });
    const button = await screen.findByRole("button", { name: "Switch to the Neovim plugin" });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(mocks.mutateAsync).toHaveBeenCalledExactlyOnceWith();
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: getGetWorkspaceSettingQueryKey("editor_backend"),
      }),
    );
  });

  it("disables the switch while built-in sessions are running", async () => {
    mocks.status.sessions_running = [4, 7];
    render(<NeovimPluginMigration />);
    const button = await screen.findByRole("button", { name: "Switch to the Neovim plugin" });
    expect(button).toBeDisabled();
    expect(
      screen.getByText(/save and quit your open full Neovim sessions first/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/2 conversations active/i)).toBeInTheDocument();
  });

  it("points to Custom tabs when consent is required", async () => {
    mocks.status.plugin = "consent_required";
    render(<NeovimPluginMigration />);
    expect(
      await screen.findByText(/review and accept the Neovim plugin's permissions/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open custom tabs/i })).toHaveAttribute(
      "href",
      "/settings?section=custom-tabs",
    );
  });

  it("points to Custom tabs when the plugin is not enabled", async () => {
    mocks.status.plugin = "disabled";
    render(<NeovimPluginMigration />);
    expect(await screen.findByText(/enable the Neovim plugin first/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open custom tabs/i })).toHaveAttribute(
      "href",
      "/settings?section=custom-tabs",
    );
  });

  it("points to the Marketplace when the plugin is not installed", async () => {
    mocks.status.plugin = "not_installed";
    render(<NeovimPluginMigration />);
    expect(
      await screen.findByText(/install the Neovim plugin from the Marketplace first/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open marketplace/i })).toHaveAttribute(
      "href",
      "/marketplace",
    );
  });

  it("explains when the plugin is blocked", async () => {
    mocks.status.plugin = "blocked";
    render(<NeovimPluginMigration />);
    expect(await screen.findByText(/blocked by CadencR's revocation policy/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the server refusal when the migration fails", async () => {
    mocks.mutateAsync.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        data: {
          code: "NEOVIM_SESSIONS_RUNNING",
          error: "built-in Neovim sessions are still running (features: 4)",
        },
      },
    });
    const { user } = render(<NeovimPluginMigration />);
    await user.click(await screen.findByRole("button", { name: "Switch to the Neovim plugin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "built-in Neovim sessions are still running (features: 4)",
    );
  });
});

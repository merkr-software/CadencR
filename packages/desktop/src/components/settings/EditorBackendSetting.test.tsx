import { useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import { pluginTabSummary } from "@/components/plugin-tabs/plugin-tab-fixtures";
import { EditorBackendSetting } from "./EditorBackendSetting";

const mocks = vi.hoisted(() => ({
  desktop: false,
  mobile: false,
  backend: "codemirror" as string | null,
  vim: "0",
  persist: vi.fn(),
  migrate: vi.fn(),
}));
const { showError } = vi.hoisted(() => ({ showError: vi.fn() }));
const editor = pluginTabSummary({
  id: "example-editor",
  editor: { label: "Plugin editor", open_method: "files.open" },
  backend: {
    protocol: 2,
    binary: { "darwin-aarch64": "bin/editor", "linux-x86_64": "bin/editor" },
    reasoning: "Edit files.",
  },
});
const neovimPlugin = pluginTabSummary({
  id: "neovim",
  editor: { label: "Neovim plugin", open_method: "files.open" },
  backend: {
    protocol: 2,
    binary: { "darwin-aarch64": "bin/editor", "linux-x86_64": "bin/editor" },
    reasoning: "Edit files.",
  },
});

vi.mock("@/api/generated", async (original) => {
  const api = await original<typeof import("@/api/generated")>();
  return {
    ...api,
    useGetWorkspaceSetting: (key: string) =>
      useQuery({
        queryKey: api.getGetWorkspaceSettingQueryKey(key),
        queryFn: async () => ({ value: key === "editor_backend" ? mocks.backend : mocks.vim }),
        initialData: { value: key === "editor_backend" ? mocks.backend : mocks.vim },
        staleTime: Infinity,
      }),
    usePluginTabList: () => ({ data: [editor, neovimPlugin], isLoading: false, isError: false }),
    useMigrationStatusRoute: () => ({
      data: { plugin: "ready", sessions_running: [] },
      isLoading: false,
      isError: false,
    }),
    setWorkspaceSetting: mocks.persist,
    useMigrateToPluginRoute: () => ({ mutateAsync: mocks.migrate, isPending: false }),
  };
});
vi.mock("sonner", () => ({ toast: { error: showError } }));
vi.mock("@/lib/plugin-tabs/availability", () => ({
  pluginTabsAvailable: () => mocks.desktop,
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => mocks.mobile }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop = false;
  mocks.mobile = false;
  mocks.backend = "codemirror";
  mocks.vim = "0";
  mocks.persist.mockImplementation(async (_key: string, data: { value: string }) => data);
  mocks.migrate.mockResolvedValue({ migrated: true, editor_backend: "plugin:neovim" });
});

describe("editor backend choices", () => {
  it.each([false, true])(
    "allows switching to built-in Neovim and back with desktop=%s",
    async (desktop) => {
      mocks.desktop = desktop;
      const { user } = render(<EditorBackendSetting />);
      const neovim = screen.getByRole("radio", { name: /Full Neovim/ });
      expect(neovim).toBeEnabled();
      expect(neovim).not.toHaveTextContent("Requires the desktop app");
      await user.click(neovim);
      await waitFor(() => expect(neovim).toHaveAttribute("aria-checked", "true"));
      expect(mocks.persist).toHaveBeenCalledWith("editor_backend", { value: "neovim" });
      const codemirror = screen.getByRole("radio", { name: /CodeMirror/ });
      await user.click(codemirror);
      await waitFor(() => expect(codemirror).toHaveAttribute("aria-checked", "true"));
      expect(mocks.persist).toHaveBeenLastCalledWith("editor_backend", { value: "codemirror" });
    },
  );

  it.each([false, true])("keeps built-in Neovim disabled on mobile with desktop=%s", (desktop) => {
    mocks.desktop = desktop;
    mocks.mobile = true;
    render(<EditorBackendSetting />);
    expect(screen.getByRole("radio", { name: /Full Neovim/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /CodeMirror/ })).toBeEnabled();
  });

  it("keeps legacy full Neovim selected and usable in a non-mobile browser", () => {
    mocks.backend = null;
    mocks.vim = "2";
    render(<EditorBackendSetting />);
    const neovim = screen.getByRole("radio", { name: /Full Neovim/ });
    expect(neovim).toHaveAttribute("aria-checked", "true");
    expect(neovim).toBeEnabled();
  });

  it("routes the plugin:neovim choice through the guarded migration", async () => {
    mocks.desktop = true;
    const { user } = render(<EditorBackendSetting />);
    await user.click(screen.getByRole("radio", { name: /Neovim plugin/ }));
    await waitFor(() => expect(mocks.migrate).toHaveBeenCalledTimes(1));
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("surfaces a refused migration instead of switching the editor", async () => {
    mocks.desktop = true;
    mocks.migrate.mockRejectedValue(new Error("built-in Neovim sessions are still running"));
    const { user } = render(<EditorBackendSetting />);
    await user.click(screen.getByRole("radio", { name: /Neovim plugin/ }));
    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith("built-in Neovim sessions are still running"),
    );
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it.each([
    { desktop: false, mobile: false, enabled: false },
    { desktop: true, mobile: false, enabled: true },
    { desktop: true, mobile: true, enabled: false },
  ])("restricts plugin editors with desktop=$desktop/mobile=$mobile", (environment) => {
    mocks.desktop = environment.desktop;
    mocks.mobile = environment.mobile;
    render(<EditorBackendSetting />);
    const plugin = screen.getByRole("radio", { name: /Plugin editor/ });
    if (environment.enabled) expect(plugin).toBeEnabled();
    else expect(plugin).toBeDisabled();
  });
});

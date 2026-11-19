import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, createTestQueryClient } from "@/test-utils";
import { VimMotionsSetting } from "./VimMotionsSetting";
const mocks = vi.hoisted(() => ({ persist: vi.fn(), backend: null as string | null, vim: "2" }));
vi.mock("@/api/generated", async (original) => ({
  ...(await original<typeof import("@/api/generated")>()),
  useGetWorkspaceSetting: (key: string) => ({
    data: { value: key === "editor_backend" ? mocks.backend : mocks.vim },
  }),
  useSetWorkspaceSetting: () => ({ mutateAsync: mocks.persist }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.backend = null;
  mocks.vim = "2";
  mocks.persist.mockResolvedValue({});
});
describe("Vim motions remain independent of editor identity", () => {
  it("acknowledges the legacy Neovim choice before changing the motion setting", async () => {
    let acknowledge!: (result: object) => void;
    mocks.persist.mockReturnValueOnce(
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
    );
    const { user } = render(<VimMotionsSetting />);
    await user.click(screen.getByRole("switch"));
    expect(mocks.persist).toHaveBeenCalledExactlyOnceWith({
      key: "editor_backend",
      data: { value: "neovim" },
    });
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByText("Saving Vim motions…")).toBeInTheDocument();
    acknowledge({});
    await waitFor(() =>
      expect(mocks.persist).toHaveBeenCalledWith({
        key: "editor_vim_mode_level",
        data: { value: "0" },
      }),
    );
  });
  it("never changes an explicitly selected plugin", async () => {
    mocks.backend = "plugin:example";
    const { user } = render(<VimMotionsSetting />);
    await user.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(mocks.persist).toHaveBeenCalledExactlyOnceWith({
        key: "editor_vim_mode_level",
        data: { value: "0" },
      }),
    );
  });
  it("leaves both settings unchanged when pinning the legacy choice fails", async () => {
    mocks.persist.mockRejectedValueOnce(new Error("Unavailable"));
    const client = createTestQueryClient();
    const { user } = render(<VimMotionsSetting />, { queryClient: client });
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(screen.getByRole("switch")).not.toBeDisabled());
    expect(mocks.persist).toHaveBeenCalledOnce();
    expect(client.getQueryData(["/api/workspace/settings/editor_backend"])).toBeUndefined();
  });
});

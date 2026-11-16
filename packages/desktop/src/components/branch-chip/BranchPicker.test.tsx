import { beforeEach, describe, expect, it, vi } from "vitest";

import { render, screen } from "@/test-utils";

const mocks = vi.hoisted(() => ({
  listBranches: vi.fn(),
  updateTarget: vi.fn(),
  linkBranch: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useListBranches: (params: unknown) => {
    mocks.listBranches(params);
    return {
      data: [
        { name: "main", is_local: true },
        { name: "origin/main", is_local: false },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };
  },
  useUpdateTargetBranch: () => ({ mutateAsync: mocks.updateTarget }),
  useLinkFeatureBranch: () => ({ mutateAsync: mocks.linkBranch }),
}));

import { LinkBranchPicker, TargetBranchPicker } from "./BranchPicker";

beforeEach(() => {
  mocks.listBranches.mockReset();
  mocks.updateTarget.mockReset();
  mocks.updateTarget.mockResolvedValue({ success: true });
  mocks.linkBranch.mockReset();
  mocks.linkBranch.mockResolvedValue({ success: true });
});

describe("TargetBranchPicker", () => {
  it.each([
    { kind: "local", name: "main" },
    { kind: "remote", name: "origin/main" },
  ] as const)("persists the exact $kind branch ref for its branch", async ({ kind, name }) => {
    const onPicked = vi.fn();
    const { user } = render(
      <TargetBranchPicker
        featureId={42}
        projectId={7}
        branch="fix/b"
        currentTarget="develop"
        onPicked={onPicked}
      />,
    );

    await user.click(screen.getByRole("button", { name: `Select ${kind} branch ${name}` }));

    expect(mocks.listBranches).toHaveBeenCalledWith({ project_id: 7 });
    expect(mocks.updateTarget).toHaveBeenCalledWith({
      id: 42,
      data: { target_branch: name, branch: "fix/b" },
    });
    expect(onPicked).toHaveBeenCalledOnce();
  });

  it("closes without a request when the current target is picked again", async () => {
    const onPicked = vi.fn();
    const { user } = render(
      <TargetBranchPicker
        featureId={42}
        projectId={7}
        branch="fix/b"
        currentTarget="main"
        onPicked={onPicked}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Select local branch main" }));
    expect(mocks.updateTarget).not.toHaveBeenCalled();
    expect(onPicked).toHaveBeenCalledOnce();
  });
});

describe("LinkBranchPicker", () => {
  it("links the picked branch to the conversation", async () => {
    const onLinked = vi.fn();
    const { user } = render(<LinkBranchPicker featureId={42} projectId={7} onLinked={onLinked} />);
    await user.click(screen.getByRole("button", { name: "Select remote branch origin/main" }));
    expect(mocks.linkBranch).toHaveBeenCalledWith({ id: 42, data: { branch: "origin/main" } });
    expect(onLinked).toHaveBeenCalledOnce();
  });
});

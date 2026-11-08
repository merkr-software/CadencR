import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { render, screen } from "@/test-utils";

const mocks = vi.hoisted(() => {
  const mergeMutateAsync = vi.fn();
  const useMergeFeatureBranch = vi.fn(() => ({
    mutateAsync: mergeMutateAsync,
    isPending: false,
  }));
  const toastSuccess = vi.fn();
  const toastError = vi.fn();
  const toastWarning = vi.fn();
  return {
    mergeMutateAsync,
    useMergeFeatureBranch,
    toastSuccess,
    toastError,
    toastWarning,
  };
});

vi.mock("@/api/generated", () => ({
  getGetWorkspaceSettingQueryKey: (key: string): string[] => ["workspace-setting", key],
  useGetWorkspaceSetting: vi.fn(() => ({ data: null })),
  useMergeFeatureBranch: mocks.useMergeFeatureBranch,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

import MergeDialog from "./MergeDialog";

beforeEach(() => {
  mocks.mergeMutateAsync.mockReset();
  mocks.useMergeFeatureBranch.mockClear();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.toastWarning.mockReset();
});

describe("MergeDialog errors", () => {
  it("shows an explicit message when the target worktree has uncommitted changes", async () => {
    mocks.mergeMutateAsync.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        data: {
          error: "Bad request: target branch worktree has uncommitted changes",
          code: "BAD_REQUEST",
        },
      },
    });

    const { user } = render(<MergeDialog featureId={1076} open={true} onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Merge" }));

    const message =
      "Cannot merge because the target branch worktree has uncommitted changes. Commit, stash, or discard those changes, then try again.";
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("renders the conflict files returned by the backend as a structured list", async () => {
    // Regression: the old UI rendered an empty "git merge … failed:" tail
    // because the backend dropped stdout (where conflict detail lives).
    // The backend now returns `conflict_files` + a sentence that counts
    // them; the dialog must surface both so the user knows exactly which
    // files need resolution.
    const message =
      "Merge conflict in 2 files. Resolve the conflicts in 'main', commit the result, then try merging 'feature/x' again.";
    mocks.mergeMutateAsync.mockResolvedValueOnce({
      success: false,
      error: message,
      conflict_files: ["src/foo.ts", "src/bar.ts"],
    });

    const { user } = render(<MergeDialog featureId={1076} open={true} onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Merge" }));

    // Sentence is surfaced verbatim (no doubled "Merge failed:" prefix).
    expect(await screen.findByText(message)).toBeInTheDocument();
    // Each file is rendered as a list item beneath the message, wrappable
    // after each `/` on narrow screens without changing its text.
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(items[0]?.querySelectorAll("wbr")).toHaveLength(1);
  });

  it("scrolls the error into view, below the option cards on a phone", async () => {
    const scrollIntoView = vi.mocked(window.HTMLElement.prototype.scrollIntoView);
    scrollIntoView.mockClear();
    mocks.mergeMutateAsync.mockResolvedValueOnce({
      success: false,
      error: "Merge conflict in 1 file. Resolve the conflict in 'main'.",
      conflict_files: ["src/foo.ts"],
    });

    const { user } = render(<MergeDialog featureId={1076} open={true} onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Merge" }));

    const alert = await screen.findByRole("alert");
    expect(scrollIntoView.mock.contexts).toContain(alert);
  });

  it("caps the rendered conflict list and shows an overflow hint", async () => {
    // Per `frontend-performance.md` we never render unbounded lists. A
    // pathological merge can flag hundreds of files; the dialog must cap
    // the visible rows and tell the user how many were elided.
    const files = Array.from({ length: 60 }, (_, i) => `src/file-${i}.ts`);
    mocks.mergeMutateAsync.mockResolvedValueOnce({
      success: false,
      error: "Merge conflict in 60 files. Resolve them.",
      conflict_files: files,
    });

    const { user } = render(<MergeDialog featureId={1076} open={true} onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Merge" }));

    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(50);
    expect(screen.getByText(/\+ 10 more files/)).toBeInTheDocument();
  });

  it("never renders an empty `failed:` tail when git produced no output", async () => {
    // Regression for the original bug: empty git output used to render
    // `git merge … failed:` with nothing after the colon. The backend
    // now always returns a non-empty message; surface it as-is.
    mocks.mergeMutateAsync.mockResolvedValueOnce({
      success: false,
      error: "git merge feature/x failed with no output — run it manually to see why.",
    });

    const { user } = render(<MergeDialog featureId={1076} open={true} onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Merge" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.trim().endsWith(":")).toBe(false);
    expect(alert).toHaveTextContent(/with no output/);
  });

  it("shows explicit source-worktree errors from non-throwing merge results", async () => {
    mocks.mergeMutateAsync.mockResolvedValueOnce({
      success: false,
      error: "Bad request: source feature worktree has uncommitted changes",
    });

    const { user } = render(<MergeDialog featureId={1076} open={true} onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Merge" }));

    expect(
      await screen.findByText(
        "Cannot merge because the source feature worktree has uncommitted changes. Commit, stash, or discard those changes, then try again.",
      ),
    ).toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("surfaces a cleanup warning returned with a successful merge", async () => {
    const warning =
      "Could not switch '/repo' back to 'other': checkout failed. It is still on 'main'.";
    mocks.mergeMutateAsync.mockResolvedValueOnce({ success: true, warning });
    const onOpenChange = vi.fn();

    const { user } = render(
      <MergeDialog featureId={1076} open={true} onOpenChange={onOpenChange} />,
    );
    await user.click(screen.getByRole("button", { name: "Merge" }));

    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).toHaveBeenCalledWith(warning);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("merges on Cmd+Enter while focus is on a merge-option radio card", async () => {
    mocks.mergeMutateAsync.mockImplementationOnce(() => new Promise(() => {}));

    const { user } = render(<MergeDialog featureId={1076} open={true} onOpenChange={vi.fn()} />);
    // The new layout exposes merge options as radio cards inside the
    // "Merge option" radiogroup — focus one of them and confirm Cmd+Enter
    // still routes through the dialog's keydown handler.
    const group = screen.getByRole("radiogroup", { name: /merge option/i });
    const firstRadio = group.querySelector('[role="radio"]') as HTMLElement;
    firstRadio.focus();

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(mocks.mergeMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("merges on Cmd+Enter immediately after open without clicking inside first", () => {
    mocks.mergeMutateAsync.mockImplementationOnce(() => new Promise(() => {}));

    render(<MergeDialog featureId={1076} open={true} onOpenChange={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter", metaKey: true });

    expect(mocks.mergeMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("does not auto-focus a merge-option radio card on open", () => {
    // Regression: Radix Dialog's default `onOpenAutoFocus` used to land the
    // focus ring on the first radio card, contradicting the *selected* card
    // (the user's saved default may be `--no-ff`, not the first option).
    render(<MergeDialog featureId={1076} open={true} onOpenChange={vi.fn()} />);

    const group = screen.getByRole("radiogroup", { name: /merge option/i });
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    for (const radio of radios) {
      expect(radio).not.toBe(document.activeElement);
    }
  });

  it("renders visible keyboard-shortcut hints on the footer buttons", () => {
    render(<MergeDialog featureId={1076} open={true} onOpenChange={vi.fn()} />);

    // The `<KbdShortcut>` badges render as `<kbd>` elements inside each
    // button. We assert their presence so the discoverable shortcut isn't
    // accidentally regressed back to a `title` tooltip.
    const cancel = screen.getByRole("button", { name: /cancel/i });
    const merge = screen.getByRole("button", { name: /^merge/i });
    expect(cancel.querySelector("kbd")).not.toBeNull();
    expect(merge.querySelector("kbd")).not.toBeNull();
  });

  it("renders the colored flag chips alongside each merge-option label", () => {
    render(<MergeDialog featureId={1076} open={true} onOpenChange={vi.fn()} />);

    // Same set of chips the settings page exposes.
    expect(screen.getByText("--no-ff")).toBeInTheDocument();
    expect(screen.getByText("--ff-only")).toBeInTheDocument();
    expect(screen.getByText("--squash")).toBeInTheDocument();
    expect(screen.getByText("Git default")).toBeInTheDocument();
  });
});

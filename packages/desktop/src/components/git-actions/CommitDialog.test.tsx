/**
 * CommitDialog test suite.
 *
 * Covers the three behaviors that have user-facing impact:
 *   1. Successful submit calls `useCommit` with the trimmed message + selected
 *      paths and closes the dialog.
 *   2. A backend `{ success: false, error }` response is surfaced inside the
 *      streaming terminal frame (per `error-handling.md`) and the dialog
 *      stays open.
 *   3. A thrown mutation error is surfaced in the same terminal frame.
 *
 * The Orval-generated hooks are mocked through `vi.hoisted` so the same
 * mutation/query pair is shared across tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";
import { render, screen, waitFor } from "@/test-utils";
import { useCommitOutputStore } from "@/stores/useCommitOutputStore";
import { useCommitSubmission } from "./useCommitSubmission";

// Stable mock return values: the dialog has a `useEffect` keyed on the file
// list reference; if we built a fresh array every render the effect would
// loop forever and React would throw "Maximum update depth exceeded".
const mocks = vi.hoisted(() => {
  const mutateAsyncMock = vi.fn();
  const commitResult = { mutateAsync: mutateAsyncMock, isPending: false };
  const useCommitMock = vi.fn(() => commitResult);
  const filesResult = {
    data: [
      { path: "src/a.ts", status: "unstaged", change_kind: "M" },
      { path: "src/b.ts", status: "untracked", change_kind: "A" },
    ],
    isLoading: false,
    isError: false,
    error: null,
  };
  const useGetUncommittedFilesMock = vi.fn(() => filesResult);
  const toastSuccessMock = vi.fn();
  const toastErrorMock = vi.fn();
  return {
    mutateAsyncMock,
    useCommitMock,
    useGetUncommittedFilesMock,
    toastSuccessMock,
    toastErrorMock,
  };
});

vi.mock("@/api/generated", () => ({
  useCommit: mocks.useCommitMock,
  useGetUncommittedFiles: mocks.useGetUncommittedFilesMock,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccessMock,
    error: mocks.toastErrorMock,
  },
}));

import CommitDialog from "./CommitDialog";

interface TestCommitDialogProps {
  featureId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function TestCommitDialog({ featureId, open, onOpenChange }: TestCommitDialogProps): ReactElement {
  const submission = useCommitSubmission({ featureId, open, onOpenChange });
  return <CommitDialog featureId={featureId} open={open} submission={submission} />;
}

beforeEach(() => {
  mocks.mutateAsyncMock.mockReset();
  mocks.useCommitMock.mockClear();
  mocks.useGetUncommittedFilesMock.mockClear();
  mocks.toastSuccessMock.mockReset();
  mocks.toastErrorMock.mockReset();
  useCommitOutputStore.setState({ byFeature: {} });
});

describe("CommitDialog", () => {
  it("submits the trimmed message + every selected path and closes on success", async () => {
    mocks.mutateAsyncMock.mockResolvedValueOnce({ success: true, error: null });
    const onOpenChange = vi.fn();

    const { user } = render(
      <TestCommitDialog featureId={42} open={true} onOpenChange={onOpenChange} />,
    );

    const textarea = screen.getByPlaceholderText("Commit message");
    await user.type(textarea, "  feat: do thing  ");

    await user.click(screen.getByRole("button", { name: "Commit" }));

    expect(mocks.mutateAsyncMock).toHaveBeenCalledTimes(1);
    const call = mocks.mutateAsyncMock.mock.calls[0][0];
    expect(call.data.feature_id).toBe(42);
    expect(call.data.message).toBe("feat: do thing");
    // The component default-selects every uncommitted file; both paths should
    // be in the payload.
    expect(call.data.file_paths.sort()).toEqual(["src/a.ts", "src/b.ts"]);

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(mocks.toastSuccessMock).toHaveBeenCalledWith("Committed");
  });

  it("shows inline stderr and stays open when the backend reports success=false", async () => {
    mocks.mutateAsyncMock.mockResolvedValueOnce({
      success: false,
      error: "fatal: nothing to commit\nbecause: tree is clean",
    });
    const onOpenChange = vi.fn();

    const { user } = render(
      <TestCommitDialog featureId={1} open={true} onOpenChange={onOpenChange} />,
    );

    await user.type(screen.getByPlaceholderText("Commit message"), "msg");
    await user.click(screen.getByRole("button", { name: "Commit" }));

    expect(await screen.findByText(/fatal: nothing to commit/)).toBeInTheDocument();
    // Dialog stays open — we never call onOpenChange(false) on a failure path.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(mocks.toastSuccessMock).not.toHaveBeenCalled();
  });

  it("surfaces a thrown mutation error inline", async () => {
    mocks.mutateAsyncMock.mockRejectedValueOnce(new Error("network down"));
    const onOpenChange = vi.fn();

    const { user } = render(
      <TestCommitDialog featureId={1} open={true} onOpenChange={onOpenChange} />,
    );

    await user.type(screen.getByPlaceholderText("Commit message"), "msg");
    await user.click(screen.getByRole("button", { name: "Commit" }));

    // Regex (not exact-string) match: the error is appended to the streamed
    // terminal `<pre>`, whose textContent may include preceding chunks.
    expect(await screen.findByText(/network down/)).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("lets the user continue a running pre-commit hook in the background", async () => {
    let resolveCommit: ((value: { success: boolean; error: null }) => void) | undefined;
    mocks.mutateAsyncMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCommit = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    const { user } = render(
      <TestCommitDialog featureId={9} open={true} onOpenChange={onOpenChange} />,
    );

    await user.type(screen.getByPlaceholderText("Commit message"), "feat: background hook");
    await user.click(screen.getByRole("button", { name: "Commit" }));

    expect(screen.getByText("Committing changes")).toBeInTheDocument();
    expect(screen.getByText(/Pre-commit hooks are running/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run in background" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(useCommitOutputStore.getState().byFeature[9]?.status).toBe("running");

    resolveCommit?.({ success: true, error: null });
    await waitFor(() => {
      expect(mocks.toastSuccessMock).toHaveBeenCalledWith("Background commit completed");
    });
  });

  it("moves an already-running commit to the background on Meta+Enter", async () => {
    mocks.mutateAsyncMock.mockReturnValueOnce(new Promise(() => {}));
    const onOpenChange = vi.fn();
    const { user } = render(
      <TestCommitDialog featureId={10} open={true} onOpenChange={onOpenChange} />,
    );

    await user.type(screen.getByPlaceholderText("Commit message"), "feat: keyboard background");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(screen.getByText("Committing changes")).toBeInTheDocument();

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(useCommitOutputStore.getState().byFeature[10]?.status).toBe("running");
    expect(mocks.mutateAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("disables the submit button when the message is empty", () => {
    render(<TestCommitDialog featureId={1} open={true} onOpenChange={() => {}} />);
    const button = screen.getByRole("button", { name: "Commit" });
    expect(button).toBeDisabled();
  });

  it("submits on ⌘+Enter from the textarea", async () => {
    mocks.mutateAsyncMock.mockResolvedValueOnce({ success: true, error: null });
    const onOpenChange = vi.fn();

    const { user } = render(
      <TestCommitDialog featureId={7} open={true} onOpenChange={onOpenChange} />,
    );

    const textarea = screen.getByPlaceholderText("Commit message");
    await user.type(textarea, "feat: shortcut");
    // userEvent maps `{Meta>}` to `metaKey: true` for the wrapped key. We
    // exercise the macOS path because that's the codepath every dev hits;
    // the handler also accepts Ctrl on non-Mac, but `metaKey` is the
    // representative case.
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(mocks.mutateAsyncMock).toHaveBeenCalledTimes(1);
    const call = mocks.mutateAsyncMock.mock.calls[0][0];
    expect(call.data.message).toBe("feat: shortcut");
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("submits on ⌘+Enter even when the key event starts outside dialog content", async () => {
    mocks.mutateAsyncMock.mockResolvedValueOnce({ success: true, error: null });
    const onOpenChange = vi.fn();

    const { user } = render(
      <TestCommitDialog featureId={7} open={true} onOpenChange={onOpenChange} />,
    );

    await user.type(screen.getByPlaceholderText("Commit message"), "feat: global shortcut");
    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter", metaKey: true });

    expect(mocks.mutateAsyncMock).toHaveBeenCalledTimes(1);
    const call = mocks.mutateAsyncMock.mock.calls[0][0];
    expect(call.data.message).toBe("feat: global shortcut");
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("does not submit on bare Enter inside the textarea (newline insertion)", async () => {
    const { user } = render(<TestCommitDialog featureId={7} open={true} onOpenChange={() => {}} />);

    const textarea = screen.getByPlaceholderText("Commit message");
    await user.type(textarea, "line one{Enter}line two");

    expect(mocks.mutateAsyncMock).not.toHaveBeenCalled();
    expect((textarea as HTMLTextAreaElement).value).toBe("line one\nline two");
  });

  it("resets the draft when a controlled dialog closes", async () => {
    const { user, rerender } = render(
      <TestCommitDialog featureId={7} open={true} onOpenChange={vi.fn()} />,
    );
    await user.type(screen.getByPlaceholderText("Commit message"), "temporary draft");

    rerender(<TestCommitDialog featureId={7} open={false} onOpenChange={vi.fn()} />);
    rerender(<TestCommitDialog featureId={7} open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByPlaceholderText("Commit message")).toHaveValue("");
  });
});

/**
 * Tests for the file-selection persistence fix (P2.6):
 *   "default-select seulement à l'ouverture / premier load, puis intersecter
 *    avec les paths encore présents".
 *
 * Before the fix, a refetch (triggered by any `git.status` WS envelope while
 * the dialog was open) re-ran the default-select effect, wiping every
 * deselection the user had just made.
 */
describe("CommitDialog file-selection persistence across refetch", () => {
  function makeFile(path: string) {
    return { path, status: "unstaged", change_kind: "M" };
  }

  function setFiles(files: ReturnType<typeof makeFile>[]) {
    mocks.useGetUncommittedFilesMock.mockReturnValue({
      data: files,
      isLoading: false,
      isError: false,
      error: null,
    });
  }

  it("preserves a user deselection when the same file list refetches", async () => {
    setFiles([makeFile("src/a.ts"), makeFile("src/b.ts"), makeFile("src/c.ts")]);
    mocks.mutateAsyncMock.mockResolvedValueOnce({ success: true, error: null });

    const { user, rerender } = render(
      <TestCommitDialog featureId={1} open={true} onOpenChange={vi.fn()} />,
    );

    // All three default-selected on first load.
    const cbA = (await screen.findByLabelText(/src\/a\.ts/)) as HTMLButtonElement;
    const cbB = (await screen.findByLabelText(/src\/b\.ts/)) as HTMLButtonElement;
    const cbC = (await screen.findByLabelText(/src\/c\.ts/)) as HTMLButtonElement;
    expect(cbA.getAttribute("aria-checked")).toBe("true");
    expect(cbB.getAttribute("aria-checked")).toBe("true");
    expect(cbC.getAttribute("aria-checked")).toBe("true");

    // User deselects b.
    await user.click(cbB);
    expect(cbB.getAttribute("aria-checked")).toBe("false");

    // Simulate a refetch returning the SAME set. The mock is already
    // returning the same array; force a re-render so the dialog re-runs
    // its default-select effect with a fresh `files` reference.
    setFiles([makeFile("src/a.ts"), makeFile("src/b.ts"), makeFile("src/c.ts")]);
    rerender(<TestCommitDialog featureId={1} open={true} onOpenChange={vi.fn()} />);

    // b must remain deselected — the bug we're guarding against was that
    // the default-select effect reset selection to {a, b, c}.
    expect((await screen.findByLabelText(/src\/b\.ts/)).getAttribute("aria-checked")).toBe("false");
    expect((await screen.findByLabelText(/src\/a\.ts/)).getAttribute("aria-checked")).toBe("true");
    expect((await screen.findByLabelText(/src\/c\.ts/)).getAttribute("aria-checked")).toBe("true");

    // Submit and assert the payload reflects the user's intent: {a, c}.
    await user.type(screen.getByPlaceholderText("Commit message"), "msg");
    await user.click(screen.getByRole("button", { name: "Commit" }));
    const call = mocks.mutateAsyncMock.mock.calls[0][0];
    expect(call.data.file_paths.sort()).toEqual(["src/a.ts", "src/c.ts"]);
  });

  it("drops a deselected file from selection when it disappears from the refetch", async () => {
    setFiles([makeFile("src/a.ts"), makeFile("src/b.ts"), makeFile("src/c.ts")]);
    mocks.mutateAsyncMock.mockResolvedValueOnce({ success: true, error: null });

    const { user, rerender } = render(
      <TestCommitDialog featureId={1} open={true} onOpenChange={vi.fn()} />,
    );

    await screen.findByLabelText(/src\/b\.ts/);

    // Refetch returns just [a, c] — b vanished (e.g. user reverted it
    // outside the app). Selection should also drop b without disturbing
    // a / c.
    setFiles([makeFile("src/a.ts"), makeFile("src/c.ts")]);
    rerender(<TestCommitDialog featureId={1} open={true} onOpenChange={vi.fn()} />);

    expect(screen.queryByLabelText(/src\/b\.ts/)).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Commit message"), "msg");
    await user.click(screen.getByRole("button", { name: "Commit" }));
    const call = mocks.mutateAsyncMock.mock.calls[0][0];
    expect(call.data.file_paths.sort()).toEqual(["src/a.ts", "src/c.ts"]);
  });

  it("default-selects a brand-new file from a refetch while preserving prior deselection", async () => {
    setFiles([makeFile("src/a.ts"), makeFile("src/b.ts"), makeFile("src/c.ts")]);
    mocks.mutateAsyncMock.mockResolvedValueOnce({ success: true, error: null });

    const { user, rerender } = render(
      <TestCommitDialog featureId={1} open={true} onOpenChange={vi.fn()} />,
    );

    const cbB = (await screen.findByLabelText(/src\/b\.ts/)) as HTMLButtonElement;
    await user.click(cbB);
    expect(cbB.getAttribute("aria-checked")).toBe("false");

    // Refetch: a, b, c, d. d is brand-new (the user has never seen it
    // this session), so it should arrive default-selected. b stays
    // deselected because the user explicitly chose so.
    setFiles([
      makeFile("src/a.ts"),
      makeFile("src/b.ts"),
      makeFile("src/c.ts"),
      makeFile("src/d.ts"),
    ]);
    rerender(<TestCommitDialog featureId={1} open={true} onOpenChange={vi.fn()} />);

    expect((await screen.findByLabelText(/src\/d\.ts/)).getAttribute("aria-checked")).toBe("true");
    expect((await screen.findByLabelText(/src\/b\.ts/)).getAttribute("aria-checked")).toBe("false");

    await user.type(screen.getByPlaceholderText("Commit message"), "msg");
    await user.click(screen.getByRole("button", { name: "Commit" }));
    const call = mocks.mutateAsyncMock.mock.calls[0][0];
    expect(call.data.file_paths.sort()).toEqual(["src/a.ts", "src/c.ts", "src/d.ts"]);
  });
});

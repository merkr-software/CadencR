/**
 * PushDialog test suite.
 *
 * Covers the three user-facing behaviors:
 *
 *   1. Force-mode selection — `f` / `l` mnemonics and the mouse path both
 *      reach the mutation body, and Cmd+Enter submits with the selection.
 *   2. Background/reopen — Cmd+Enter during a run closes the dialog without
 *      cancelling the push.
 *   3. The SSH-prompt retry path: when `usePushInput().mutateAsync` rejects,
 *      the prompt input must STAY visible with the typed value preserved
 *      (the user has to be able to retry without retyping a passphrase),
 *      and a toast surfaces the failure.
 *
 * Mock strategy mirrors `CommitDialog.test.tsx`: hoisted `vi.fn` mocks for
 * the orval hooks so each test can choose its own `mutateAsync` behavior.
 * The real `usePushSubmission` is wired through a harness, exactly like
 * `GitActionButton` does in the app.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { act, render, screen, waitFor } from "@/test-utils";
import { usePushOutputStore } from "@/stores/usePushOutputStore";

const mocks = vi.hoisted(() => {
  const pushMutateAsync = vi.fn();
  const pushInputMutateAsync = vi.fn();
  const pushResult = { mutateAsync: pushMutateAsync, isPending: false };
  // We toggle `isPending` per test by mutating this object before render.
  const pushInputResult = { mutateAsync: pushInputMutateAsync, isPending: false };
  const usePushMock = vi.fn(() => pushResult);
  const usePushInputMock = vi.fn(() => pushInputResult);
  const toastSuccess = vi.fn();
  const toastError = vi.fn();
  return {
    pushMutateAsync,
    pushInputMutateAsync,
    pushInputResult,
    pushResult,
    usePushMock,
    usePushInputMock,
    toastSuccess,
    toastError,
  };
});

vi.mock("@/components/ToastScope", () => ({
  scopedToastDescription: (scope: unknown, description?: unknown) => ({ scope, description }),
}));
vi.mock("@/api/generated", async (importOriginal) => {
  // `PushForceMode` is a plain const object in the generated client; the
  // dialog indexes it, so keep the real value and stub only the hooks.
  const actual = await importOriginal<typeof import("@/api/generated")>();
  return {
    PushForceMode: actual.PushForceMode,
    usePush: mocks.usePushMock,
    usePushInput: mocks.usePushInputMock,
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

import PushDialog from "./PushDialog";
import { usePushSubmission } from "./usePushSubmission";

interface TestPushDialogProps {
  featureId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Mirrors `GitActionDialogs`: the controller keeps rendering (it lives in
 * `GitActionButton`) while the dialog itself unmounts on close. Anything
 * that must survive backgrounding therefore has to live in the controller,
 * and these tests would catch it drifting back into the dialog.
 */
function TestPushDialog({
  featureId,
  open,
  onOpenChange,
}: TestPushDialogProps): ReactElement | null {
  const submission = usePushSubmission({ featureId, open, onOpenChange });
  if (!open) return null;
  return <PushDialog featureId={featureId} open submission={submission} />;
}

beforeEach(() => {
  mocks.pushMutateAsync.mockReset();
  mocks.pushInputMutateAsync.mockReset();
  mocks.pushInputResult.isPending = false;
  mocks.pushResult.isPending = false;
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  // Wipe the streaming buffer between tests so seeded prompts don't leak.
  usePushOutputStore.setState({ byFeature: {} });
});

/**
 * Seed the streaming store as if the backend had already streamed an
 * `Enter passphrase for key '/x'` prompt — which is what triggers
 * `detectSshPrompt` to render the input form.
 */
function seedPrompt(featureId: number): void {
  const store = usePushOutputStore.getState();
  store.start(featureId);
  store.append(featureId, "Enter passphrase for key '/home/u/.ssh/id_ed25519':");
}

/**
 * The picker renders through the shared `RadioCardGroup`, whose accessible
 * name is the whole card (label + mnemonic + description). Selecting by
 * position keeps these assertions readable and immune to copy edits.
 */
function selectedMode(): string | undefined {
  const group = screen.getByRole("radiogroup", { name: /push mode/i });
  const checked = group.querySelector('[role="radio"][aria-checked="true"]');
  return checked?.textContent?.trim().split(/\s{2,}|\n/)[0];
}

describe("PushDialog force modes", () => {
  it("does not push until the user asks for it", () => {
    render(<TestPushDialog featureId={1} open={true} onOpenChange={vi.fn()} />);
    expect(mocks.pushMutateAsync).not.toHaveBeenCalled();
  });

  it("pushes without a force flag by default", async () => {
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    const { user } = render(<TestPushDialog featureId={1} open={true} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /^Push$/ }));

    expect(mocks.pushMutateAsync).toHaveBeenCalledWith({
      data: { feature_id: 1, force: "none" },
    });
  });

  it("selects force-with-lease with the l mnemonic and submits it with Cmd+Enter", async () => {
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    const { user } = render(<TestPushDialog featureId={4} open={true} onOpenChange={vi.fn()} />);

    await user.keyboard("l");
    expect(selectedMode()).toMatch(/^Force with lease/);

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(mocks.pushMutateAsync).toHaveBeenCalledWith({
      data: { feature_id: 4, force: "force-with-lease" },
    });
  });

  it("moves between modes with the f and p mnemonics", async () => {
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    const { user } = render(<TestPushDialog featureId={5} open={true} onOpenChange={vi.fn()} />);

    await user.keyboard("f");
    expect(selectedMode()).toMatch(/^Force(?! with)/);

    // `p` is the way back to a plain push — the default is never mouse-only.
    await user.keyboard("p");
    expect(selectedMode()).toMatch(/^Push/);

    await user.keyboard("f");
    await user.click(screen.getByRole("button", { name: /Force push/ }));

    expect(mocks.pushMutateAsync).toHaveBeenCalledWith({
      data: { feature_id: 5, force: "force" },
    });
  });
});

describe("PushDialog picker affordances", () => {
  it("does not auto-focus a mode card on open", () => {
    // Regression: Radix's default `onOpenAutoFocus` put a focus ring on the
    // first card, competing with the radio dot that marks the real selection.
    render(<TestPushDialog featureId={1} open={true} onOpenChange={vi.fn()} />);

    const group = screen.getByRole("radiogroup", { name: /push mode/i });
    for (const radio of group.querySelectorAll('[role="radio"]')) {
      expect(radio).not.toBe(document.activeElement);
    }
  });

  it("gives every mode a visible mnemonic, including the default", () => {
    render(<TestPushDialog featureId={1} open={true} onOpenChange={vi.fn()} />);

    const group = screen.getByRole("radiogroup", { name: /push mode/i });
    const badges = [...group.querySelectorAll("kbd")].map((k) => k.textContent?.trim());
    expect(badges).toEqual(["P", "L", "F"]);
  });

  it("shows the exact command each mode will run", async () => {
    const { user } = render(<TestPushDialog featureId={1} open={true} onOpenChange={vi.fn()} />);

    expect(screen.getByText("git push -u origin HEAD")).toBeInTheDocument();

    await user.keyboard("l");
    expect(screen.getByText("git push -u --force-with-lease origin HEAD")).toBeInTheDocument();

    await user.keyboard("f");
    expect(screen.getByText("git push -u --force origin HEAD")).toBeInTheDocument();
  });
});

describe("PushDialog background run", () => {
  it("backgrounds a running push with Cmd+Enter instead of starting a second one", async () => {
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    const onOpenChange = vi.fn();
    const { user } = render(
      <TestPushDialog featureId={6} open={true} onOpenChange={onOpenChange} />,
    );

    await user.click(screen.getByRole("button", { name: /^Push$/ }));
    expect(await screen.findByRole("button", { name: /Run in background/ })).toBeInTheDocument();

    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.pushMutateAsync).toHaveBeenCalledTimes(1);
    // The run is still live in the store, which is what lets the user reopen it.
    expect(usePushOutputStore.getState().byFeature[6]?.status).toBe("running");
  });

  it("keeps the chosen force mode when a backgrounded push fails and is reopened", async () => {
    let settle: ((value: { success: boolean; error: string }) => void) | undefined;
    mocks.pushMutateAsync.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    const { user, rerender } = render(
      <TestPushDialog featureId={13} open={true} onOpenChange={onOpenChange} />,
    );

    await user.keyboard("f");
    await user.click(screen.getByRole("button", { name: /^Force push$/ }));
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<TestPushDialog featureId={13} open={false} onOpenChange={onOpenChange} />);

    await act(async () => {
      settle?.({ success: false, error: "non-fast-forward" });
    });
    rerender(<TestPushDialog featureId={13} open={true} onOpenChange={onOpenChange} />);

    // The retry offers the mode that actually ran, not a plain push.
    expect(screen.getByRole("button", { name: /Retry — force push/ })).toBeInTheDocument();
  });

  it("shows the still-running output when reopened", async () => {
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    const { rerender } = render(
      <TestPushDialog featureId={8} open={true} onOpenChange={vi.fn()} />,
    );
    usePushOutputStore.getState().start(8);
    usePushOutputStore.getState().append(8, "Enumerating objects: 12, done.");

    rerender(<TestPushDialog featureId={8} open={false} onOpenChange={vi.fn()} />);
    rerender(<TestPushDialog featureId={8} open={true} onOpenChange={vi.fn()} />);

    expect(await screen.findByText(/Enumerating objects/)).toBeInTheDocument();
  });
});

describe("PushDialog SSH prompt retry", () => {
  it("keeps the prompt input visible with the typed value when sendInput throws, then submits successfully on retry", async () => {
    // The push itself never resolves during the test — it stays "running"
    // while we exercise the prompt submit path.
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    // First call rejects (network drop), second call succeeds.
    mocks.pushInputMutateAsync
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(undefined);

    const { user } = render(<TestPushDialog featureId={42} open={true} onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /^Push$/ }));
    seedPrompt(42);

    // Wait for the prompt input to appear (the buffer change triggers a
    // re-render via the zustand selector).
    const input = (await screen.findByLabelText(/Enter passphrase for key/)) as HTMLInputElement;
    await user.type(input, "hunter2");
    await user.click(screen.getByRole("button", { name: /Send/i }));

    // After the first (failed) submit:
    //   - toast.error was called
    //   - input is still visible
    //   - typed value is preserved
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledTimes(1);
    });
    const stillThere = (await screen.findByLabelText(
      /Enter passphrase for key/,
    )) as HTMLInputElement;
    expect(stillThere).toBeInTheDocument();
    expect(stillThere.value).toBe("hunter2");

    // Retry — second click resolves. Input + value should now clear.
    await user.click(screen.getByRole("button", { name: /Send/i }));

    await waitFor(() => {
      expect(mocks.pushInputMutateAsync).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText(/Enter passphrase for key/)).not.toBeInTheDocument();
    });
  });

  it("does not re-ask an answered prompt after the dialog is reopened", async () => {
    mocks.pushMutateAsync.mockImplementation(() => new Promise(() => {}));
    mocks.pushInputMutateAsync.mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();

    const { user, rerender } = render(
      <TestPushDialog featureId={9} open={true} onOpenChange={onOpenChange} />,
    );
    await user.click(screen.getByRole("button", { name: /^Push$/ }));
    seedPrompt(9);

    const input = (await screen.findByLabelText(/Enter passphrase for key/)) as HTMLInputElement;
    await user.type(input, "secret");
    await user.click(screen.getByRole("button", { name: /Send/i }));
    await waitFor(() => {
      expect(screen.queryByLabelText(/Enter passphrase for key/)).not.toBeInTheDocument();
    });

    rerender(<TestPushDialog featureId={9} open={false} onOpenChange={onOpenChange} />);
    rerender(<TestPushDialog featureId={9} open={true} onOpenChange={onOpenChange} />);

    expect(screen.queryByLabelText(/Enter passphrase for key/)).not.toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});

describe("PushDialog success", () => {
  it("closes after push succeeds and leaves git refresh to the WS status event", async () => {
    mocks.pushMutateAsync.mockResolvedValue({ success: true });
    const onOpenChange = vi.fn();

    const { user } = render(
      <TestPushDialog featureId={7} open={true} onOpenChange={onOpenChange} />,
    );
    await user.click(screen.getByRole("button", { name: /^Push$/ }));

    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Pushed");
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces a backend failure in the terminal pane and offers a retry", async () => {
    mocks.pushMutateAsync.mockResolvedValue({
      success: false,
      error: "Updates were rejected because the tip of your branch is behind",
    });
    const onOpenChange = vi.fn();

    const { user } = render(
      <TestPushDialog featureId={12} open={true} onOpenChange={onOpenChange} />,
    );
    await user.click(screen.getByRole("button", { name: /^Push$/ }));

    expect(await screen.findByText(/Updates were rejected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

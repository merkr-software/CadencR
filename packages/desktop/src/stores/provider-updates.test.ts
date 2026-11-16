// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import {
  getGetProviderUpdatesQueryKey,
  updateProvider,
  type ProviderUpdateStatus,
} from "@/api/generated";
import { queryClient } from "@/lib/queryClient";
import { applyProviderUpdatesEvent, startProviderUpdate } from "@/stores/provider-updates";

vi.mock("@/api/generated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/generated")>();
  return { ...actual, updateProvider: vi.fn() };
});

const navigate = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/router", () => ({ router: { navigate } }));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

function status(overrides: Partial<ProviderUpdateStatus> = {}): ProviderUpdateStatus {
  return {
    provider_id: "claude_code",
    label: "Claude Code",
    origin: "built_in",
    state: "update_available",
    activity: null,
    current_version: "2.1.299",
    latest_version: "2.1.300",
    available_versions: ["2.1.300"],
    supports_target_version: false,
    error: null,
    ...overrides,
  };
}

describe("provider update notifications", () => {
  beforeEach(() => {
    localStorage.clear();
    queryClient.clear();
    vi.mocked(toast).mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.loading).mockClear();
    vi.mocked(toast.dismiss).mockClear();
    vi.mocked(updateProvider).mockReset();
    navigate.mockClear();
  });

  it("caches the status list and toasts a new version exactly once", () => {
    applyProviderUpdatesEvent({ providers: [status()], checked_at: null, outcome: null });
    applyProviderUpdatesEvent({ providers: [status()], checked_at: null, outcome: null });

    expect(queryClient.getQueryData(getGetProviderUpdatesQueryKey())).toEqual({
      providers: [status()],
      checked_at: null,
    });
    expect(toast).toHaveBeenCalledOnce();
    expect(vi.mocked(toast).mock.calls[0][0]).toBe("Claude Code 2.1.300 is available");

    applyProviderUpdatesEvent({
      providers: [status({ latest_version: "2.1.301", available_versions: ["2.1.301"] })],
    });
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it("groups several newly detected versions into one toast", () => {
    applyProviderUpdatesEvent({
      providers: [
        status(),
        status({ provider_id: "codex_cli", label: "Codex", latest_version: "0.162.1" }),
        status({ provider_id: "cursor", label: "Cursor", state: "up_to_date" }),
      ],
    });
    expect(toast).toHaveBeenCalledOnce();
    expect(vi.mocked(toast).mock.calls[0][0]).toBe("Provider updates available");
    expect(vi.mocked(toast).mock.calls[0][1]?.description).toBe(
      "Claude Code 2.1.300 · Codex 0.162.1",
    );
  });

  it("reveals the providers section even when settings is already on it", async () => {
    const section = document.createElement("section");
    section.id = "providers";
    section.scrollIntoView = vi.fn();
    document.body.append(section);
    applyProviderUpdatesEvent({
      providers: [status(), status({ provider_id: "codex_cli", label: "Codex" })],
    });
    const review = vi.mocked(toast).mock.calls[0][1]?.action;
    if (!review || typeof review !== "object" || !("onClick" in review)) {
      throw new Error("expected a Review action");
    }

    review.onClick({} as React.MouseEvent<HTMLButtonElement>);
    await vi.waitFor(() => expect(section.scrollIntoView).toHaveBeenCalledOnce());
    expect(navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: "providers" } });
    section.remove();
  });

  it("reports update outcomes", () => {
    applyProviderUpdatesEvent({
      providers: [status({ state: "up_to_date", current_version: "2.1.300" })],
      outcome: {
        provider_id: "claude_code",
        label: "Claude Code",
        success: true,
        previous_version: "2.1.299",
        current_version: "2.1.300",
        message: null,
      },
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Claude Code updated",
      expect.objectContaining({ id: "provider-update-claude_code" }),
    );

    applyProviderUpdatesEvent({
      providers: [status()],
      outcome: {
        provider_id: "claude_code",
        label: "Claude Code",
        success: false,
        message: "EACCES",
      },
    });
    expect(toast.error).toHaveBeenCalledWith(
      "Claude Code update failed",
      expect.objectContaining({ description: "EACCES" }),
    );
  });

  it("clears the announcement's buttons once the update starts and finishes", async () => {
    // Sonner merges options into the toast already shown under the same id,
    // so each later stage must explicitly clear "Update" / "Details".
    const cleared = { action: undefined, cancel: undefined, duration: undefined };
    vi.mocked(updateProvider).mockResolvedValueOnce(status({ activity: "updating" }));
    await startProviderUpdate(status());
    expect(toast.loading).toHaveBeenCalledWith(
      "Updating Claude Code…",
      expect.objectContaining({ ...cleared, id: "provider-update-claude_code" }),
    );

    applyProviderUpdatesEvent({
      providers: [status({ state: "up_to_date", current_version: "2.1.300" })],
      outcome: {
        provider_id: "claude_code",
        label: "Claude Code",
        success: true,
        previous_version: "2.1.299",
        current_version: "2.1.300",
      },
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Claude Code updated",
      expect.objectContaining({ ...cleared, id: "provider-update-claude_code" }),
    );
  });

  it("keeps the toast open when its Update button starts the update", () => {
    vi.mocked(updateProvider).mockResolvedValueOnce(status({ activity: "updating" }));
    applyProviderUpdatesEvent({ providers: [status()], checked_at: null, outcome: null });
    const options = vi.mocked(toast).mock.calls[0][1] as unknown as {
      action: { onClick: (event: { preventDefault: () => void }) => void };
    };
    const preventDefault = vi.fn();

    options.action.onClick({ preventDefault });

    // Unprevented, sonner would close the toast that turns into "Updating…".
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(toast.loading).toHaveBeenCalledWith(
      "Updating Claude Code…",
      expect.objectContaining({ id: "provider-update-claude_code" }),
    );
  });

  it("rejects malformed events without touching the cache", () => {
    applyProviderUpdatesEvent({ providers: [{ provider_id: 4 }] });
    expect(queryClient.getQueryData(getGetProviderUpdatesQueryKey())).toBeUndefined();
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it("closes a loading toast whose outcome event was missed", async () => {
    vi.mocked(updateProvider).mockResolvedValueOnce(status({ activity: "updating" }));
    await startProviderUpdate(status());
    applyProviderUpdatesEvent({ providers: [status({ activity: "updating" })] });
    expect(toast.dismiss).not.toHaveBeenCalled();

    // Reconnected after the update finished: the snapshot has no outcome.
    applyProviderUpdatesEvent({ providers: [status({ state: "up_to_date" })] });
    expect(toast.dismiss).toHaveBeenCalledWith("provider-update-claude_code");
  });

  it("starts an update with a loading toast and reports a refused request", async () => {
    vi.mocked(updateProvider).mockResolvedValueOnce(status({ activity: "updating" }));
    await startProviderUpdate(status(), "2.1.300");
    expect(updateProvider).toHaveBeenCalledWith("claude_code", { version: "2.1.300" });
    expect(toast.loading).toHaveBeenCalledWith(
      "Updating Claude Code…",
      expect.objectContaining({ id: "provider-update-claude_code" }),
    );

    vi.mocked(updateProvider).mockRejectedValueOnce(new Error("in progress"));
    await startProviderUpdate(status());
    expect(updateProvider).toHaveBeenLastCalledWith("claude_code", {});
    expect(toast.error).toHaveBeenCalledWith(
      "Could not update Claude Code",
      expect.objectContaining({ description: "in progress" }),
    );
  });
});

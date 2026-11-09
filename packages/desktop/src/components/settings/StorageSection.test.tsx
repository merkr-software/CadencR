import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ArchivedCleanupRunStatus, type ArchivedCleanupRunResponse } from "@/api/generated";
import { act, fireEvent, render, screen } from "@/test-utils";
import { useSetting, type Setting } from "@/hooks/useSetting";
import {
  applyStorageMaintenanceEvent,
  clearStorageMaintenanceStatus,
} from "@/stores/storage-maintenance-store";
import { StorageSection } from "./StorageSection";

vi.mock("@/hooks/useSetting", () => ({
  useSetting: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  useRunArchivedCleanup: vi.fn(),
}));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useRunArchivedCleanup: apiMocks.useRunArchivedCleanup,
}));

type SettingSetter = Setting["setValue"];

const setters = new Map<string, Mock<SettingSetter>>();
const values = new Map<string, string | null>();
let runData: ArchivedCleanupRunResponse | undefined;

function setter(key: string): Mock<SettingSetter> {
  const existing = setters.get(key);
  if (existing) return existing;
  const created = vi.fn<SettingSetter>().mockResolvedValue(true);
  setters.set(key, created);
  return created;
}

function toggle(): HTMLElement {
  return screen.getByRole("switch", { name: /compact archived features/i });
}

function daysField(): HTMLInputElement {
  return screen.getByRole("spinbutton", { name: /days before an archived feature/i });
}

function runNowButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /run now/i });
}

describe("StorageSection", () => {
  beforeEach(() => {
    apiMocks.mutate.mockReset();
    apiMocks.useRunArchivedCleanup.mockReset();
    runData = undefined;
    apiMocks.useRunArchivedCleanup.mockImplementation(() => ({
      mutate: apiMocks.mutate,
      isPending: false,
      data: runData,
    }));
    setters.clear();
    values.clear();
    vi.mocked(useSetting).mockImplementation((key: string) => ({
      value: values.get(key) ?? null,
      setValue: setter(key),
      isLoading: false,
      isFetched: true,
      isSaving: false,
    }));
  });

  afterEach(() => clearStorageMaintenanceStatus());

  it("shows compaction off with a disabled 30-day window before anything is saved", () => {
    render(<StorageSection />);

    // Both defaults mirror the backend's SettingSpec, so a fresh install reads
    // the same on screen as it behaves on disk.
    expect(toggle()).not.toBeChecked();
    expect(daysField()).toHaveValue(30);
    expect(daysField()).toBeDisabled();
    expect(runNowButton()).toBeDisabled();
  });

  it("waits for backend confirmation instead of updating the policy optimistically", async () => {
    render(<StorageSection />);

    await userEvent.click(toggle());

    expect(setter("retention_compact_archived_enabled")).toHaveBeenCalledWith("true");
    expect(toggle()).not.toBeChecked();
  });

  it("persists the switch", async () => {
    render(<StorageSection />);

    await userEvent.click(toggle());

    expect(setter("retention_compact_archived_enabled")).toHaveBeenCalledWith("true");
  });

  it("disables the window field when compaction is off", () => {
    values.set("retention_compact_archived_enabled", "false");
    render(<StorageSection />);

    expect(toggle()).not.toBeChecked();
    expect(daysField()).toBeDisabled();
  });

  // `fireEvent.change` rather than `userEvent.type`: the field shows a draft
  // that each change replaces, so typing would append to it.
  it.each([
    // Zero days would compact a feature the instant it was archived.
    ["0", "1"],
    ["-5", "1"],
    ["9999", "365"],
    // An emptied field falls back to the default rather than to zero.
    ["", "30"],
  ])("clamps a window of %s to %s days", (typed, persisted) => {
    values.set("retention_compact_archived_enabled", "true");
    render(<StorageSection />);

    vi.useFakeTimers();
    try {
      fireEvent.change(daysField(), { target: { value: typed } });
      expect(daysField()).toHaveValue(Number(persisted));
      expect(setter("retention_compact_archived_days")).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(500));
      expect(setter("retention_compact_archived_days")).toHaveBeenLastCalledWith(persisted);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a persisted window", () => {
    values.set("retention_compact_archived_enabled", "true");
    values.set("retention_compact_archived_days", "90");
    render(<StorageSection />);

    expect(daysField()).toHaveValue(90);
  });

  it("starts cleanup only after the persisted policy is enabled", async () => {
    values.set("retention_compact_archived_enabled", "true");
    render(<StorageSection />);

    await userEvent.click(runNowButton());

    expect(apiMocks.mutate).toHaveBeenCalledOnce();
  });

  it("shows the backend-confirmed manual-run result", () => {
    values.set("retention_compact_archived_enabled", "true");
    const view = render(<StorageSection />);

    runData = {
      status: ArchivedCleanupRunStatus.started,
      eligible_features: 2,
    };
    view.rerender(<StorageSection />);

    expect(screen.getByText(/cleanup started for 2 archived conversations/i)).toBeInTheDocument();
  });

  it.each([
    [ArchivedCleanupRunStatus.already_running, /storage maintenance is already running/i],
    [ArchivedCleanupRunStatus.nothing_due, /no archived conversations currently need cleanup/i],
  ])("shows the %s result returned by the backend", (status, message) => {
    values.set("retention_compact_archived_enabled", "true");
    const view = render(<StorageSection />);

    runData = { status, eligible_features: 0 };
    view.rerender(<StorageSection />);

    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("does not start a second sweep while backend progress is active", () => {
    values.set("retention_compact_archived_enabled", "true");
    applyStorageMaintenanceEvent({
      phase: "progress",
      task: "cleanup",
      completed: 1,
      total: 4,
    });

    render(<StorageSection />);

    expect(screen.getByRole("button", { name: /cleanup running/i })).toBeDisabled();
  });
});

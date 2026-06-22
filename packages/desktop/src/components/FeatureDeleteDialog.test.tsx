import { describe, it, expect, beforeEach, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@/test-utils";
import { FeatureDeleteDialog } from "./FeatureDeleteDialog";
import type { Feature } from "@/api/generated";

const { mockKillTerminals, mockListFeatureActivity } = vi.hoisted(() => ({
  mockKillTerminals: vi.fn(),
  mockListFeatureActivity: vi.fn(),
}));

vi.mock("@/api/generated", () => ({
  useKillTerminalSessions: vi.fn(() => ({ mutateAsync: mockKillTerminals })),
  useListFeatureActivity: mockListFeatureActivity,
}));

vi.mock("sonner", () => ({
  toast: {
    promise: vi.fn((promise: Promise<unknown>) => promise),
    error: vi.fn(),
  },
}));

const feature: Feature = {
  id: 7,
  title: "Feature Seven",
  status: "active",
  type: "ws-session",
  project_id: 1,
  is_pinned: false,
  created_at: "2026-01-01T00:00:00Z",
};

function renderDialog() {
  const onDelete = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <FeatureDeleteDialog open feature={feature} onOpenChange={onOpenChange} onDelete={onDelete} />,
  );
  return { onDelete, onOpenChange };
}

describe("FeatureDeleteDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKillTerminals.mockResolvedValue({ killed: 0 });
    mockListFeatureActivity.mockReturnValue({ data: [] });
  });

  function withRunningShells(count: number): void {
    mockListFeatureActivity.mockReturnValue({
      data: [{ feature_id: feature.id, shell_count: count }],
    });
  }

  it("deletes without killing terminals when none are running", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderDialog();

    expect(screen.queryByText("Kill terminals")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /delete/i }));

    expect(onDelete).toHaveBeenCalledWith(7);
    expect(mockKillTerminals).not.toHaveBeenCalled();
  });

  it("kills running terminals via the T shortcut when deleting", async () => {
    withRunningShells(1);
    const user = userEvent.setup();
    const { onDelete } = renderDialog();

    expect(screen.getByText(/Stop the 1 running shell\b/i)).toBeInTheDocument();

    await user.keyboard("t");
    await user.click(screen.getByRole("button", { name: /delete/i }));

    expect(onDelete).toHaveBeenCalledWith(7);
    expect(mockKillTerminals).toHaveBeenCalledWith({ params: { feature_id: 7 } });
  });

  it("deletes the feature even when the kill option is unchecked", async () => {
    withRunningShells(1);
    const user = userEvent.setup();
    const { onDelete } = renderDialog();

    await user.click(screen.getByRole("button", { name: /delete/i }));

    expect(onDelete).toHaveBeenCalledWith(7);
    expect(mockKillTerminals).not.toHaveBeenCalled();
  });
});

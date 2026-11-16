import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUpdateStatus, ProviderUpdatesResponse } from "@/api/generated";
import { ProviderUpdatesCard } from "./ProviderUpdatesCard";

const { checkMutate, startProviderUpdate, query } = vi.hoisted(() => ({
  checkMutate: vi.fn(),
  startProviderUpdate: vi.fn(() => Promise.resolve()),
  query: {
    data: undefined as ProviderUpdatesResponse | undefined,
    isLoading: false,
    isError: false,
  },
}));

vi.mock("@/api/generated", () => ({
  useGetProviderUpdates: () => query,
  useCheckProviderUpdates: () => ({ mutate: checkMutate, isPending: false }),
}));
vi.mock("@/stores/provider-updates", () => ({ startProviderUpdate }));
vi.mock("@/lib/remote/device-token", () => ({ isBrowserRemote: () => false }));
vi.mock("@/lib/provider-icons", () => ({ ProviderIcon: () => null }));

function status(overrides: Partial<ProviderUpdateStatus>): ProviderUpdateStatus {
  return {
    provider_id: "claude_code",
    label: "Claude Code",
    origin: "built_in",
    state: "up_to_date",
    activity: null,
    current_version: "2.1.300",
    latest_version: "2.1.300",
    available_versions: ["2.1.300"],
    supports_target_version: false,
    error: null,
    ...overrides,
  };
}

describe("ProviderUpdatesCard", () => {
  beforeEach(() => {
    checkMutate.mockReset();
    startProviderUpdate.mockClear();
  });

  it("renders every provider's state and updates to the latest version", async () => {
    query.data = {
      checked_at: null,
      providers: [
        status({}),
        status({
          provider_id: "codex_cli",
          label: "Codex",
          state: "update_available",
          current_version: "0.162.0",
          latest_version: "0.162.1",
        }),
        status({
          provider_id: "cursor",
          label: "Cursor",
          state: "check_failed",
          error: "could not reach the Cursor installer",
        }),
        status({
          provider_id: "acme",
          label: "Acme",
          origin: "installed_local",
          state: "unsupported",
        }),
      ],
    };
    render(<ProviderUpdatesCard />);

    expect(screen.getByText("Up to date")).toBeTruthy();
    expect(screen.getByText("could not reach the Cursor installer")).toBeTruthy();
    expect(screen.getByText("Updates not managed")).toBeTruthy();
    expect(screen.getByText("Connector")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Update to 0.162.1" }));
    expect(startProviderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ provider_id: "codex_cli" }),
      undefined,
    );

    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(checkMutate).toHaveBeenCalledOnce();
  });

  it("shows running work instead of actions", () => {
    query.data = {
      checked_at: null,
      providers: [status({ state: "update_available", activity: "updating" })],
    };
    render(<ProviderUpdatesCard />);
    expect(screen.getByText("Updating…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Update to/ })).toBeNull();
  });
});

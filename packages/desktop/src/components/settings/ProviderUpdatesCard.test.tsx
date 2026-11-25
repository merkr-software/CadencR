import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUpdateStatus, ProviderUpdatesResponse } from "@/api/generated";
import { ProviderUpdatesCard } from "./ProviderUpdatesCard";
import { uiI18n } from "@/lib/i18n/ui";

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

it("updates the mounted status, action and timestamp when switching language", async () => {
  query.data = {
    checked_at: new Date(Date.now() - 120_000).toISOString(),
    providers: [
      status({ label: "Up to date", provider_id: "local-provider" }),
      status({
        label: "My Connector",
        provider_id: "my-connector",
        origin: "installed_local",
        state: "update_available",
        latest_version: "2.1.400-beta",
      }),
    ],
  };
  render(<ProviderUpdatesCard />);
  expect(screen.getByText(/Last checked 2 minutes ago/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Update to 2.1.400-beta" })).toBeInTheDocument();

  const prefix = "settings.providers.providerUpdatesCard";
  uiI18n.addResource("fr", "ui", `${prefix}.lastCheck`, "[{{relative}}]");
  uiI18n.addResource("fr", "ui", `${prefix}.upToDate`, "[up to date]");
  uiI18n.addResource("fr", "ui", `${prefix}.updateTo`, "[update {{version}}]");
  try {
    await act(async () => {
      await uiI18n.changeLanguage("fr-CA");
    });
    expect(screen.getByText("[il y a 2 minutes]")).toBeInTheDocument();
    expect(screen.getByText("[up to date]")).toBeInTheDocument();
    expect(screen.getByText("Up to date")).toBeInTheDocument();
    expect(screen.getByText("My Connector")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "[update 2.1.400-beta]" })).toBeInTheDocument();
  } finally {
    await act(async () => {
      await uiI18n.changeLanguage("en");
    });
    uiI18n.removeResourceBundle("fr", "ui");
  }
});

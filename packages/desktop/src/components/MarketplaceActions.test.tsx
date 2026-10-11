import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/test-utils";
import {
  catalog,
  inventory,
  install,
  update,
  remove,
  enabled,
  type ManagedProviderInventoryEntry,
  type ManagedProviderPackage,
  type SignedManagedProviderIndex,
} from "@/api/generated";
import { useMarketplace } from "@/hooks/useMarketplace";
import { MarketplaceDetails } from "./MarketplaceDetails";
import { MarketplaceSection } from "./MarketplaceSection";
import { InstalledProvider } from "./InstalledProvider";

vi.mock("@/api/generated", () => ({
  catalog: vi.fn(),
  inventory: vi.fn(),
  refreshCatalog: vi.fn(),
  enabled: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("react-virtuoso", () => ({
  Virtuoso: <T,>({
    data,
    itemContent,
  }: {
    data: T[];
    itemContent: (index: number, entry: T) => ReactNode;
  }) => (
    <div data-testid="history-virtual-list">
      {data.map((entry, index) => (
        <div key={index}>{itemContent(index, entry)}</div>
      ))}
    </div>
  ),
}));
const packages: ManagedProviderPackage[] = ["1.0.0", "2.0.0"].map((version) => ({
  agent: {
    id: "example",
    name: "Example provider",
    description: "A real ACP package",
    version,
    distribution: { npx: { package: `example@${version}` } },
  },
  host: {
    publisher: "Example publisher",
    compatibility: { min_app_version: "0.1.0" },
    assets: { icon: "icon.svg" },
  },
}));
const index: SignedManagedProviderIndex = {
  signature: { algorithm: "ed25519", key_id: "release-key", value: "signed-envelope" },
  signed: {
    schema_version: 1,
    generated_at: "2026-01-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    packages,
  },
};
const entry: ManagedProviderInventoryEntry = {
  id: "example",
  version: "1.0.0",
  digest: "package-digest",
  active_now: false,
  active_after_restart: true,
  enabled_after_restart: true,
  restart_required: true,
  history: [
    {
      action: "installed",
      sequence: 1,
      occurred_at: "2026-01-01T00:00:00Z",
      version: "1.0.0",
      digest: "package-digest",
    },
    { action: "disabled", sequence: 2, occurred_at: "2026-01-02T00:00:00Z", version: "1.0.0" },
  ],
  quarantine: [
    {
      code: "MANAGED_CONFORMANCE_FAILED",
      message: "Verified ACP handshake failed",
      occurred_at: "2026-01-02T00:00:00Z",
      stage: "conformance",
      provider_id: "example",
      version: "2.0.0",
      sequence: 1,
    },
  ],
};
const processControl = { status: "applied" as const };
function DetailsHarness({
  installed,
  canInstall = true,
}: {
  installed?: ManagedProviderInventoryEntry;
  canInstall?: boolean;
}) {
  const { mutation } = useMarketplace();
  return (
    <MarketplaceDetails
      packages={packages}
      installed={installed}
      index={index}
      canInstall={canInstall}
      mutation={mutation}
      onClose={() => undefined}
    />
  );
}
function InstalledHarness({ provider = entry }: { provider?: ManagedProviderInventoryEntry }) {
  const { mutation } = useMarketplace();
  return <InstalledProvider entry={provider} mutation={mutation} />;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(catalog).mockResolvedValue({
    source_configured: true,
    cache_status: "verified",
    refreshed: true,
    used_cached_verified_catalog: false,
    index,
  });
  vi.mocked(inventory).mockResolvedValue({
    providers: [entry],
    root: "/test",
    trust: { status: "configured" },
    blocklist: { source_configured: true, cache_status: "verified" },
    process_policy: {
      child_count_limit: processControl,
      cpu_limit: processControl,
      memory_limit: processControl,
      descendant_termination: processControl,
      default_one_shot_timeout_seconds: 60,
    },
  });
  vi.mocked(install).mockResolvedValue(entry);
  vi.mocked(update).mockResolvedValue(entry);
  vi.mocked(enabled).mockResolvedValue(entry);
});

describe("MarketplaceDetails interactions", () => {
  it("selects an exact version and sends the untouched signed envelope", async () => {
    const { user } = render(<DetailsHarness />);
    expect(screen.getByText("Example publisher")).toBeInTheDocument();
    expect(screen.getByText(/These checks and process cleanup/)).toHaveTextContent(
      "are not an OS sandbox",
    );
    screen.getByRole("combobox", { name: "Exact version" }).focus();
    await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("option", { name: "2.0.0" }));
    await user.click(screen.getByRole("button", { name: "Install 2.0.0" }));
    await waitFor(() =>
      expect(install).toHaveBeenCalledWith({ provider_id: "example", version: "2.0.0", index }),
    );
    expect(vi.mocked(install).mock.calls[0][0].index).toBe(index);
    expect(update).not.toHaveBeenCalled();
  });
  it("disables the current revision and updates rather than installing a changed version", async () => {
    const { user } = render(<DetailsHarness installed={entry} />);
    expect(screen.getByRole("button", { name: "Installed version" })).toBeDisabled();
    screen.getByRole("combobox", { name: "Exact version" }).focus();
    await user.keyboard("{ArrowDown}");
    await user.click(screen.getByRole("option", { name: "2.0.0" }));
    await user.click(screen.getByRole("button", { name: "Change to 2.0.0" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("example", { version: "2.0.0", index }),
    );
    expect(install).not.toHaveBeenCalled();
  });
  it("blocks unavailable installs and surfaces stable service errors", async () => {
    const { rerender, user } = render(<DetailsHarness canInstall={false} />);
    expect(screen.getByRole("button", { name: "Install 1.0.0" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("current verified catalog");
    rerender(<DetailsHarness />);
    vi.mocked(install).mockRejectedValue({
      response: { data: { error: "Provider blocked by policy", code: "MANAGED_BLOCKED" } },
    });
    await user.click(screen.getByRole("button", { name: "Install 1.0.0" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "MANAGED_BLOCKED: Provider blocked by policy",
    );
    expect(install).toHaveBeenCalledTimes(1);
  });
});

describe("InstalledProvider interactions", () => {
  it("requires removal confirmation and keeps the dialog open until backend success", async () => {
    let finish: ((value: ManagedProviderInventoryEntry) => void) | undefined;
    vi.mocked(remove).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = render(<InstalledHarness />);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Remove example?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm removal" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("example"));
    expect(screen.getByRole("button", { name: "Removing…" })).toBeDisabled();
    expect(screen.getByRole("dialog", { name: "Remove example?" })).toBeInTheDocument();
    act(() =>
      finish?.({
        ...entry,
        version: null,
        digest: null,
        enabled_after_restart: false,
        active_after_restart: false,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("keeps failed removal open with an actionable error and no retry", async () => {
    vi.mocked(remove).mockRejectedValue(new Error("Could not remove provider"));
    const { user } = render(<InstalledHarness />);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Confirm removal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not remove provider");
    expect(screen.getByRole("dialog", { name: "Remove example?" })).toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it("shows restart and quarantine diagnostics, history newest first, and dispatches disable", async () => {
    const { user } = render(<InstalledHarness />);
    expect(screen.getByRole("status")).toHaveTextContent("Restart Cadencr");
    expect(screen.getByText(/Last quarantine:/)).toHaveTextContent(
      "MANAGED_CONFORMANCE_FAILED — Verified ACP handshake failed",
    );
    await user.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(enabled).toHaveBeenCalledWith("example", { enabled: false }));
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("dialog", { name: "example history" })).toBeInTheDocument();
    expect(screen.getByTestId("history-virtual-list").parentElement).toHaveClass("h-72");
    const disabled = screen.getByText("disabled · 1.0.0");
    const installed = screen.getByText("installed · 1.0.0");
    expect(
      disabled.compareDocumentPosition(installed) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("marketplace navigation during lifecycle work", () => {
  it("preserves pending work and its failure across details navigation", async () => {
    const other = {
      ...packages[0],
      agent: { ...packages[0].agent, id: "zed", name: "Zed provider" },
    };
    vi.mocked(catalog).mockResolvedValue({
      source_configured: true,
      cache_status: "verified",
      refreshed: true,
      used_cached_verified_catalog: false,
      index: { ...index, signed: { ...index.signed, packages: [...packages, other] } },
    });
    vi.mocked(inventory).mockResolvedValue({ ...(await inventory()), providers: [] });
    let reject: ((reason: Error) => void) | undefined;
    vi.mocked(install).mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const { user } = render(<MarketplaceSection />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Details" })).toHaveLength(2));
    await user.click(screen.getAllByRole("button", { name: "Details" })[0]);
    await user.click(screen.getByRole("button", { name: "Install 1.0.0" }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByText("Applying provider change…")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Details" })[1]);
    expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Applying…" }));
    expect(install).toHaveBeenCalledTimes(1);
    act(() => reject?.(new Error("Install rejected after navigation")));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((element) => element.textContent === "Install rejected after navigation"),
      ).toBe(true),
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getAllByRole("button", { name: "Details" })[0]);
    expect(
      screen
        .getAllByRole("alert")
        .some((element) => element.textContent === "Install rejected after navigation"),
    ).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
  });
});

it("labels a quarantined failed installation as not installed, not removed", () => {
  render(
    <InstalledHarness
      provider={{
        ...entry,
        version: null,
        digest: null,
        enabled_after_restart: false,
        history: [],
      }}
    />,
  );
  expect(screen.getByText(/Not installed/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  expect(screen.getByText(/Last quarantine/)).toBeInTheDocument();
});

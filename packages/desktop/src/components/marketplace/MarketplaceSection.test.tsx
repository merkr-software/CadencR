import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test-utils";
import { catalog, inventory, refreshCatalog } from "@/api/generated";
import { MarketplaceSection } from "./MarketplaceSection";

vi.unmock("react-virtuoso");

vi.mock("@/api/generated", () => ({
  catalog: vi.fn(),
  inventory: vi.fn(),
  refreshCatalog: vi.fn(),
  enabled: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  rollback: vi.fn(),
}));
const unavailable = {
  source_configured: false,
  cache_status: "missing" as const,
  refreshed: false,
  used_cached_verified_catalog: false,
  error_code: "MANAGED_CATALOG_SOURCE_NOT_CONFIGURED",
  error: "Catalog source is not configured",
};
const policy = { status: "applied" as const };
describe("MarketplaceSection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(catalog).mockResolvedValue(unavailable);
    vi.mocked(refreshCatalog).mockResolvedValue(unavailable);
    vi.mocked(inventory).mockResolvedValue({
      providers: [],
      root: "/test",
      trust: { status: "unconfigured" },
      blocklist: { source_configured: false, cache_status: "missing" },
      process_policy: {
        child_count_limit: policy,
        cpu_limit: policy,
        memory_limit: { status: "unavailable", reason: "Not enforceable on this host" },
        descendant_termination: policy,
        default_one_shot_timeout_seconds: 60,
      },
    });
  });
  it("shows progress and honest unavailable state instead of a fixture catalog", async () => {
    render(<MarketplaceSection />);
    expect(screen.getByText("Loading marketplace…")).toBeInTheDocument();
    expect(await screen.findByText(/MANAGED_CATALOG_SOURCE_NOT_CONFIGURED/)).toBeInTheDocument();
    expect(screen.getByText(/No current verified catalog is available/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Install / })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search marketplace" })).toBeInTheDocument();
    expect(screen.getByText(/Blocklist source:/)).toHaveTextContent(
      "not configured · cache: missing. No verified blocklist policy is available.",
    );
    expect(screen.getByText(/Memory limit: unavailable/)).toHaveTextContent(
      "Not enforceable on this host",
    );
    expect(screen.getByText(/Package integrity and process controls/)).toHaveTextContent(
      "not an OS sandbox",
    );
  });
  it("refreshes the real catalog endpoint and keeps installed management reachable offline", async () => {
    const { user } = render(<MarketplaceSection />);
    await screen.findByText(/MANAGED_CATALOG_SOURCE_NOT_CONFIGURED/);
    await user.click(screen.getByRole("button", { name: "Refresh catalog" }));
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("tab", { name: "Installed (0)" }));
    expect(screen.getByText("No managed providers installed.")).toBeInTheDocument();
  });
  it("constrains real browse and installed Virtuoso scrollers with bounded parents", async () => {
    vi.mocked(catalog).mockResolvedValue({
      source_configured: false,
      cache_status: "verified",
      refreshed: false,
      used_cached_verified_catalog: true,
      index: {
        signature: { algorithm: "ed25519", key_id: "release", value: "signature" },
        signed: {
          schema_version: 1,
          generated_at: "2026-01-01T00:00:00Z",
          expires_at: "2099-01-01T00:00:00Z",
          packages: [
            {
              agent: {
                id: "example",
                name: "Example",
                description: "ACP package",
                version: "1.0.0",
              },
              host: {
                publisher: "Example",
                compatibility: { min_app_version: "0.1.0" },
                assets: { icon: "icon.svg" },
              },
            },
          ],
        },
      },
    });
    vi.mocked(inventory).mockResolvedValue({
      ...(await inventory()),
      providers: [
        {
          id: "example",
          version: "1.0.0",
          digest: "digest",
          active_now: false,
          active_after_restart: true,
          enabled_after_restart: true,
          restart_required: true,
          history: [],
          quarantine: [],
        },
      ],
    });
    const { container, user } = render(<MarketplaceSection />);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="virtuoso-scroller"]')).not.toBeNull(),
    );
    const browse = container.querySelector('[data-testid="virtuoso-scroller"]');
    expect(browse).toHaveStyle({ height: "100%" });
    expect(browse?.parentElement).toHaveClass("h-80");
    await user.click(screen.getByRole("tab", { name: "Installed (1)" }));
    const installed = container.querySelector('[data-testid="virtuoso-scroller"]');
    expect(installed).toHaveStyle({ height: "100%" });
    expect(installed?.parentElement).toHaveClass("h-80");
  });
});

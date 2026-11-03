import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lspListings } from "@/lib/marketplace-lsp-listings";
import { TrustSection } from "./PluginDetailSections";

vi.mock("./MarketplaceContext", () => ({
  useMarketplaceState: () => ({
    providers: { catalogQuery: {} },
    themes: { catalog: {} },
    tabs: { catalog: {} },
    lsps: { catalog: {} },
  }),
}));

function listing(status: "legacy" | "on_path" | "managed" | "invalid") {
  return lspListings(undefined, {
    servers: [
      {
        lsp_id: "custom-server",
        name: "Custom server",
        description: "External tooling",
        language_ids: ["custom"],
        languages: [],
        role: "general",
        status,
        version: "1.0.0",
      },
    ],
  })[0];
}

describe("language server provenance", () => {
  afterEach(cleanup);

  it.each(["legacy", "on_path"] as const)(
    "does not claim marketplace verification for a %s installation without a catalog",
    (status) => {
      render(<TrustSection listing={listing(status)} version="1.0.0" />);
      expect(screen.getByText("Installed outside the marketplace")).toBeVisible();
      expect(
        screen.getByText(
          /Cadencr has not verified this executable against a signed marketplace package/,
        ),
      ).toBeVisible();
      expect(screen.queryByText("Signed catalog, verified archive")).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Installing downloads a verified executable/),
      ).not.toBeInTheDocument();
    },
  );

  it("retains the verified installation contract for managed servers", () => {
    render(<TrustSection listing={listing("managed")} version="1.0.0" />);
    expect(screen.getByText("Signed catalog, verified archive")).toBeVisible();
    expect(screen.getByText(/Installing downloads a verified executable/)).toBeVisible();
    expect(screen.queryByText(/Cadencr has not verified/)).not.toBeInTheDocument();
  });

  it("identifies a failed managed installation without claiming current verification", () => {
    render(<TrustSection listing={listing("invalid")} version="1.0.0" />);
    expect(screen.getByText("Marketplace installation unavailable")).toBeVisible();
    expect(screen.getByText(/cannot currently verify or run/)).toBeVisible();
    expect(screen.queryByText("Installed outside the marketplace")).not.toBeInTheDocument();
    expect(screen.queryByText("Signed catalog, verified archive")).not.toBeInTheDocument();
  });
});

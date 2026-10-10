import { describe, expect, it } from "vitest";
import type { ManagedCatalogResponse, ManagedProviderPackage } from "@/api/generated";
import { catalogSchema, groupPackages, usableCatalog, marketplaceError } from "./marketplace";

const provider: ManagedProviderPackage = {
  agent: {
    id: "example",
    name: "Example",
    version: "1.0.0",
    description: "ACP provider",
    distribution: { npx: { package: "example@1.0.0" } },
    vendor_extension: { preserved: true },
  },
  host: {
    publisher: "Example publisher",
    compatibility: { min_app_version: "0.1.0" },
    assets: { icon: "icon.svg" },
  },
};
const catalog: ManagedCatalogResponse = {
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
      packages: [provider],
    },
  },
};
describe("marketplace catalog boundary", () => {
  it("allows a valid verified cache without a configured source", () => {
    expect(usableCatalog(catalog)).toBe(true);
  });
  it("rejects expired, invalid, missing and malformed expiration catalogs", () => {
    for (const cache_status of ["expired", "invalid", "missing"] as const)
      expect(usableCatalog({ ...catalog, cache_status })).toBe(false);
    expect(
      usableCatalog({
        ...catalog,
        index: { ...catalog.index!, signed: { ...catalog.index!.signed, expires_at: "invalid" } },
      }),
    ).toBe(false);
    expect(
      usableCatalog({
        ...catalog,
        index: {
          ...catalog.index!,
          signed: { ...catalog.index!.signed, expires_at: "2000-01-01T00:00:00Z" },
        },
      }),
    ).toBe(false);
  });
  it("validates without dropping signed ACP extension fields", () => {
    const original = JSON.stringify(catalog);
    expect(catalogSchema.parse(catalog).index?.signed.packages[0].agent.vendor_extension).toEqual({
      preserved: true,
    });
    expect(JSON.stringify(catalog)).toBe(original);
    expect(catalogSchema.safeParse({ ...catalog, index: { signed: {} } }).success).toBe(false);
  });
  it("groups exact versions without inventing a latest version", () => {
    const other = { ...provider, agent: { ...provider.agent, version: "2.0.0" } };
    expect(groupPackages([provider, other])).toEqual([[provider, other]]);
  });
});

describe("marketplace errors", () => {
  it("renders stable backend error codes", () => {
    expect(
      marketplaceError({
        response: { data: { error: "Provider is blocked", code: "MANAGED_BLOCKED" } },
      }),
    ).toBe("MANAGED_BLOCKED: Provider is blocked");
  });
  it("does not claim failure or success after a timeout", () => {
    expect(marketplaceError({ code: "ECONNABORTED" })).toContain("outcome is unknown");
  });
});

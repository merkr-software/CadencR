import { describe, expect, it } from "vitest";
import type { ManagedCatalogResponse, ManagedProviderPackage } from "@/api/generated";
import {
  catalogSchema,
  groupPackages,
  usableCatalog,
  marketplaceError,
  providerCatalogPackages,
} from "./marketplace";

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
    expect(
      providerCatalogPackages(catalogSchema.parse(catalog).index)[0].agent.vendor_extension,
    ).toEqual({
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

const mixedCatalog: ManagedCatalogResponse = {
  ...catalog,
  index: {
    signature: catalog.index!.signature,
    signed: {
      ...catalog.index!.signed,
      schema_version: 2,
      packages: [
        { kind: "provider", package: provider },
        {
          kind: "theme",
          package: {
            theme: {
              id: "midnight",
              name: "Midnight",
              description: "Theme",
              version: "1.0.0",
              repository: "https://github.com/acme/themes",
              license: "MIT",
              document_version: 1,
              distribution: {
                archive: "https://github.com/acme/themes/releases/download/v1/theme.tgz",
                sha256: "a".repeat(64),
              },
            },
            host: { publisher: "acme", compatibility: { min_app_version: "0.1.0" } },
          },
        },
      ],
    },
  },
};
describe("mixed catalog provider presentation", () => {
  it("validates both kinds but groups only provider bodies without changing the signed envelope", () => {
    const serialized = JSON.stringify(mixedCatalog);
    expect(catalogSchema.safeParse(mixedCatalog).success).toBe(true);
    expect(usableCatalog(mixedCatalog)).toBe(true);
    expect(groupPackages(providerCatalogPackages(mixedCatalog.index))).toEqual([[provider]]);
    expect(JSON.stringify(mixedCatalog)).toBe(serialized);
  });
  it("rejects unknown envelopes, kinds, nested distribution fields, and malformed theme bodies", () => {
    const bad = structuredClone(mixedCatalog);
    for (const index of [
      { ...mixedCatalog.index, future: true },
      { ...mixedCatalog.index, signed: { ...mixedCatalog.index!.signed, schema_version: 3 } },
      {
        ...mixedCatalog.index,
        signed: {
          ...mixedCatalog.index!.signed,
          packages: [{ kind: "future", package: provider }],
        },
      },
      {
        ...mixedCatalog.index,
        signed: { ...mixedCatalog.index!.signed, packages: [{ kind: "theme", package: provider }] },
      },
      {
        ...mixedCatalog.index,
        signed: {
          ...mixedCatalog.index!.signed,
          packages: [
            {
              kind: "provider",
              package: {
                ...provider,
                agent: {
                  ...provider.agent,
                  distribution: { npx: { package: "p", cmd: "unexpected" } },
                },
              },
            },
          ],
        },
      },
    ])
      expect(catalogSchema.safeParse({ ...bad, index }).success).toBe(false);
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

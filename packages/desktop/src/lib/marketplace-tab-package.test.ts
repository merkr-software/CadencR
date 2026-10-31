import { describe, expect, it } from "vitest";
import { signedMixedCatalogSchema } from "./marketplace-catalog";
import { catalogSchema } from "./marketplace";
import { tabPackageSchema, tabNativeCode } from "./marketplace-tab-package";

const tab = {
  kind: "tab",
  package: {
    tab: {
      id: "files-graph",
      name: "Files graph",
      description: "Explore changes",
      version: "1.0.0",
      repository: "https://github.com/acme/tabs",
      license: "MIT",
      api_version: 1,
      distribution: {
        archive: "https://github.com/acme/tabs/releases/download/v1.0.0/tab.tar.gz",
        sha256: "a".repeat(64),
      },
    },
    host: { publisher: "acme", compatibility: { min_app_version: "0.13.1" } },
  },
};

function envelope(entry: unknown = tab) {
  return {
    signature: { algorithm: "ed25519", key_id: "registry", value: "signature" },
    signed: {
      schema_version: 2,
      generated_at: "2026-10-17T00:00:00Z",
      expires_at: "2026-10-18T00:00:00Z",
      packages: [entry],
    },
  };
}

describe("custom tabs in the signed marketplace catalog", () => {
  it("accepts tab entries without changing the signed payload", () => {
    const index = envelope();
    expect(signedMixedCatalogSchema.parse(index)).toEqual(index);
    expect(
      catalogSchema.parse({
        source_configured: true,
        cache_status: "verified",
        refreshed: false,
        used_cached_verified_catalog: false,
        index,
      }).index,
    ).toEqual(index);
  });

  it("rejects unknown archive launch fields and unsupported API versions", () => {
    const invalid = structuredClone(tab);
    invalid.package.tab.api_version = 2;
    expect(signedMixedCatalogSchema.safeParse(envelope(invalid)).success).toBe(false);
    expect(
      signedMixedCatalogSchema.safeParse(
        envelope({
          ...tab,
          package: {
            ...tab.package,
            tab: {
              ...tab.package.tab,
              distribution: { ...tab.package.tab.distribution, cmd: "run" },
            },
          },
        }),
      ).success,
    ).toBe(false);
  });
});

const binaryTarget = (platform: string) => ({
  archive: `https://github.com/acme/tabs/releases/download/v1.0.0/backend-${platform}.tar.gz`,
  sha256: "b".repeat(64),
  size: 1234,
  cmd: `bin/${platform}/ports`,
  executable_sha256: "c".repeat(64),
  executable_size: 4567,
});

function backendTab(
  edit: (tab: Record<string, unknown>, distribution: Record<string, unknown>) => void = () => {},
) {
  const entry = structuredClone(tab.package) as unknown as {
    tab: Record<string, unknown> & { distribution: Record<string, unknown> };
  };
  entry.tab.backend = { protocol: 1, reasoning: "Lists listening TCP ports." };
  entry.tab.distribution.binary = {
    "darwin-aarch64": binaryTarget("darwin-aarch64"),
    "linux-x86_64": binaryTarget("linux-x86_64"),
  };
  edit(entry.tab, entry.tab.distribution);
  return entry;
}

describe("custom tabs with a native backend", () => {
  it("accepts a declared backend shipped for some platforms", () => {
    const parsed = tabPackageSchema.parse(backendTab());
    expect(
      signedMixedCatalogSchema.safeParse(envelope({ kind: "tab", package: backendTab() })).success,
    ).toBe(true);
    expect(tabNativeCode(parsed)).toEqual({
      reasoning: "Lists listening TCP ports.",
      protocol: 1,
      platforms: ["darwin-aarch64", "linux-x86_64"],
    });
    const plain = tabPackageSchema.parse(tab.package);
    expect(tabNativeCode(plain)).toBeNull();
  });

  // Whether they install here is the service's call (`unavailable_versions`).
  it("accepts platforms and protocols this build does not know", () => {
    const unknown = backendTab((t, d) => {
      t.backend = { protocol: 9, reasoning: "Future backend." };
      d.binary = {
        "darwin-aarch64": binaryTarget("darwin-aarch64"),
        "haiku-riscv64": binaryTarget("haiku-riscv64"),
      };
    });
    expect(tabPackageSchema.parse(unknown).tab.backend?.protocol).toBe(9);
    expect(
      signedMixedCatalogSchema.safeParse(envelope({ kind: "tab", package: unknown })).success,
    ).toBe(true);
  });

  it.each([
    [
      "a backend without binaries",
      (_: Record<string, unknown>, d: Record<string, unknown>) => {
        delete d.binary;
      },
    ],
    [
      "binaries without a backend",
      (t: Record<string, unknown>) => {
        delete t.backend;
      },
    ],
    [
      "no platform at all",
      (_: Record<string, unknown>, d: Record<string, unknown>) => {
        d.binary = {};
      },
    ],
    [
      "an empty reasoning",
      (t: Record<string, unknown>) => {
        t.backend = { protocol: 1, reasoning: "" };
      },
    ],
    [
      "an unknown backend field",
      (t: Record<string, unknown>) => {
        t.backend = { protocol: 1, reasoning: "Why", cmd: "run" };
      },
    ],
    [
      "an unknown binary field",
      (_: Record<string, unknown>, d: Record<string, unknown>) => {
        d.binary = { "darwin-aarch64": { ...binaryTarget("darwin-aarch64"), args: ["--x"] } };
      },
    ],
    [
      "a malformed executable digest",
      (_: Record<string, unknown>, d: Record<string, unknown>) => {
        d.binary = {
          "darwin-aarch64": { ...binaryTarget("darwin-aarch64"), executable_sha256: "XYZ" },
        };
      },
    ],
    [
      "a zero archive size",
      (_: Record<string, unknown>, d: Record<string, unknown>) => {
        d.binary = { "darwin-aarch64": { ...binaryTarget("darwin-aarch64"), size: 0 } };
      },
    ],
  ])("rejects %s", (_, edit) => {
    expect(tabPackageSchema.safeParse(backendTab(edit)).success).toBe(false);
  });
});

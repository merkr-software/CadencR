import { describe, expect, it } from "vitest";
import type {
  ManagedCatalogResponse,
  ManagedProviderInventoryEntry,
  ManagedThemeCatalogResponse,
} from "@/api/generated";
import { buildListings } from "./marketplace-listings";
import { browsableListings } from "./marketplace-platform";
import { catalogSchema } from "./marketplace";

const sha = "a".repeat(64);
const MAC_ARM = "darwin-aarch64";
const MAC_INTEL = "darwin-x86_64";
const LINUX_X64 = "linux-x86_64";
const LINUX_ARM = "linux-aarch64";

const binary = (platform: string) => ({ archive: `https://x/${platform}.tgz`, cmd: "bin/a" });
const providerEntry = (id: string, version: string, platforms: string[]) => ({
  kind: "provider" as const,
  package: {
    agent: {
      id,
      name: id,
      version,
      description: `${id} agent`,
      distribution: { binary: Object.fromEntries(platforms.map((p) => [p, binary(p)])) },
    },
    host: {
      publisher: "Pub",
      compatibility: { min_app_version: "0.12.0" },
      assets: { icon: "icon.svg" },
    },
  },
});
const themeEntry = (id: string) => ({
  kind: "theme" as const,
  package: {
    theme: {
      id,
      name: id,
      description: `${id} theme`,
      version: "1.0.0",
      repository: "https://github.com/cadencr/themes",
      license: "Apache-2.0",
      document_version: 1 as const,
      distribution: { archive: `https://x/${id}.tgz`, sha256: sha },
    },
    host: { publisher: "Cadencr", compatibility: { min_app_version: "0.13.0" } },
  },
});
const tabTarget = (platform: string) => ({
  archive: `https://github.com/acme/tabs/releases/download/v1/backend-${platform}.tar.gz`,
  sha256: sha,
  size: 10,
  cmd: `bin/${platform}/ports`,
  executable_sha256: sha,
  executable_size: 20,
});
const tabEntry = (id: string, platforms: string[] | null) => ({
  kind: "tab",
  package: {
    tab: {
      id,
      name: id,
      description: `${id} tab`,
      version: "1.0.0",
      repository: "https://github.com/acme/tabs",
      license: "MIT",
      api_version: 1,
      ...(platforms ? { backend: { protocol: 1, reasoning: "Lists ports." } } : {}),
      distribution: {
        archive: "https://x/tab.tgz",
        sha256: sha,
        ...(platforms
          ? { binary: Object.fromEntries(platforms.map((p) => [p, tabTarget(p)])) }
          : {}),
      },
    },
    host: { publisher: "acme", compatibility: { min_app_version: "0.13.0" } },
  },
});

const packages = [
  providerEntry("mac-agent", "1.0.0", [MAC_ARM, MAC_INTEL]),
  providerEntry("linux-agent", "1.0.0", [LINUX_X64, LINUX_ARM]),
  // Newest build dropped macOS; an older one still ships for it.
  providerEntry("shrunk", "1.0.0", [MAC_ARM]),
  providerEntry("shrunk", "2.0.0", [LINUX_X64]),
  themeEntry("ember"),
  tabEntry("ui-only", null),
  tabEntry("mac-tab", [MAC_ARM]),
  tabEntry("linux-tab", [LINUX_X64]),
  tabEntry("future-tab", [MAC_ARM, LINUX_X64]),
];
const index = {
  signature: { algorithm: "ed25519" as const, key_id: "k", value: "v" },
  signed: {
    schema_version: 2 as const,
    generated_at: "2026-10-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    packages,
  },
};
/** The service's verdict for a provider catalog served to `host` (null: no registry name for it). */
function providerUnavailable(host: string | null) {
  const unavailable: Record<string, Record<string, "platform">> = {};
  for (const entry of packages) {
    if (entry.kind !== "provider") continue;
    const agent = (entry.package as ReturnType<typeof providerEntry>["package"]).agent;
    if (host && host in agent.distribution.binary) continue;
    (unavailable[agent.id] ??= {})[agent.version] = "platform";
  }
  return unavailable;
}
const providerCatalog = (host: string | null) =>
  ({
    source_configured: true,
    cache_status: "verified",
    refreshed: true,
    used_cached_verified_catalog: false,
    recommended_versions: {},
    unavailable_versions: providerUnavailable(host),
    index,
  }) as ManagedCatalogResponse;
const themeCatalog = {
  verified: true,
  recommended_versions: {},
  index,
} as ManagedThemeCatalogResponse;

/** The service's verdict for a tab catalog served to `host`: versions with no build, or a newer protocol. */
function tabCatalog(host: string | null): ManagedThemeCatalogResponse {
  const unavailable: Record<string, Record<string, "platform" | "protocol">> = {};
  for (const entry of packages) {
    if (entry.kind !== "tab") continue;
    const tab = (entry.package as ReturnType<typeof tabEntry>["package"]).tab;
    const binaries = Object.keys(
      (tab.distribution as { binary?: Record<string, unknown> }).binary ?? {},
    );
    if (binaries.length && !(host && binaries.includes(host)))
      unavailable[tab.id] = { "1.0.0": "platform" };
  }
  // A backend speaking a newer protocol is unavailable for a reason that is not the platform.
  if (host) unavailable["future-tab"] = { "1.0.0": "protocol" };
  return {
    verified: true,
    host_platform: host as never,
    recommended_versions: {},
    unavailable_versions: unavailable,
    index,
  } as ManagedThemeCatalogResponse;
}

function browse(host: string | null, extra: Parameters<typeof buildListings>[0] = {}) {
  const listings = buildListings({
    providerCatalog: providerCatalog(host),
    themeCatalog,
    tabCatalog: tabCatalog(host),
    ...extra,
  });
  return {
    all: listings.map((listing) => listing.key),
    shown: browsableListings(listings).map((listing) => listing.key),
  };
}

describe("platform filtering of browsing surfaces", () => {
  it("shows an Apple silicon user the macOS provider and tab, not the Linux-only ones", () => {
    const { shown, all } = browse(MAC_ARM);
    expect(shown).toContain("provider:mac-agent");
    expect(shown).not.toContain("provider:linux-agent");
    expect(shown).toContain("tab:mac-tab");
    expect(shown).not.toContain("tab:linux-tab");
    // Hidden from browsing only; the full list still has them for deep links.
    expect(all).toContain("provider:linux-agent");
    expect(all).toContain("tab:linux-tab");
  });

  it("shows an Intel Mac user only providers with a darwin-x86_64 build", () => {
    const { shown } = browse(MAC_INTEL);
    expect(shown).toContain("provider:mac-agent");
    expect(shown).not.toContain("provider:shrunk");
    expect(shown).not.toContain("provider:linux-agent");
  });

  it("shows a Linux x86-64 user the Linux provider and tab, not the macOS-only ones", () => {
    const { shown } = browse(LINUX_X64);
    expect(shown).toContain("provider:linux-agent");
    expect(shown).toContain("tab:linux-tab");
    expect(shown).not.toContain("provider:mac-agent");
    expect(shown).not.toContain("tab:mac-tab");
  });

  it("distinguishes Linux aarch64 from Linux x86-64", () => {
    const { shown } = browse(LINUX_ARM);
    expect(shown).toContain("provider:linux-agent");
    expect(shown).not.toContain("provider:shrunk");
  });

  it("keeps a package some version of which ships for this platform", () => {
    const listings = buildListings({ providerCatalog: providerCatalog(MAC_ARM) });
    const shrunk = listings.find((listing) => listing.id === "shrunk");
    expect(shrunk?.versions.map((v) => [v.version, v.unavailable])).toEqual([
      ["2.0.0", "platform"],
      ["1.0.0", undefined],
    ]);
    expect(shrunk?.availableHere).toBe(true);
    expect(browsableListings(listings).map((l) => l.id)).toContain("shrunk");
  });

  it("always shows themes and UI-only tabs", () => {
    for (const host of [MAC_ARM, MAC_INTEL, LINUX_X64, LINUX_ARM, null]) {
      const { shown } = browse(host);
      expect(shown).toContain("theme:ember");
      expect(shown).toContain("tab:ui-only");
    }
  });

  it("does not hide a version that only needs a newer Cadencr", () => {
    expect(browse(MAC_ARM).shown).toContain("tab:future-tab");
    // Even where the protocol verdict is all there is (no build named for Linux).
    expect(browse(LINUX_X64).shown).toContain("tab:future-tab");
  });

  it("keeps an installed package visible even when it has no build for this platform", () => {
    const inventory: ManagedProviderInventoryEntry = {
      id: "linux-agent",
      version: "1.0.0",
      digest: "d",
      active_now: false,
      active_after_restart: true,
      enabled_after_restart: true,
      restart_required: false,
      history: [
        { action: "installed", sequence: 1, occurred_at: "2026-09-01T00:00:00Z", version: "1.0.0" },
      ],
      quarantine: [],
    };
    const { shown } = browse(MAC_ARM, { providerInventory: [inventory] });
    expect(shown).toContain("provider:linux-agent");
  });

  it("hides every provider and tab backend, but not themes or UI-only tabs, when the host has no registry name", () => {
    const { shown } = browse(null);
    expect(shown).toContain("theme:ember");
    expect(shown).toContain("tab:ui-only");
    expect(shown.filter((key) => key.startsWith("provider:"))).toEqual([]);
    expect(shown).not.toContain("tab:mac-tab");
  });

  it("accepts the unavailable versions the service reports", () => {
    expect(catalogSchema.safeParse(providerCatalog(LINUX_X64)).success).toBe(true);
    expect(catalogSchema.safeParse(providerCatalog(null)).success).toBe(true);
  });
});

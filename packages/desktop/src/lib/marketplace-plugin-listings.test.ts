import { describe, expect, it } from "vitest";
import type {
  ManagedProviderInventoryEntry,
  ManagedTabInventoryEntry,
  ManagedThemeCatalogResponse,
} from "@/api/generated";
import { buildListings, type MarketplaceListing } from "./marketplace-listings";
import { auroraPlugin, auroraTab, auroraTheme, signedCatalog } from "./marketplace-plugin-fixtures";
import {
  installedPluginMembers,
  isStandalone,
  listingIndex,
  pluginMembers,
  pluginOffer,
  pluginSteps,
} from "./marketplace-plugin-listings";

const index = signedCatalog([auroraPlugin("1.0.0"), auroraPlugin("2.0.0")]);
const recommended = { "aurora-agent": "2.0.0", "aurora-tab": "2.0.0", "aurora-theme": "2.0.0" };

interface Installed {
  agent?: string;
  tab?: string;
  theme?: string;
}

const agentEntry = (version: string): ManagedProviderInventoryEntry => ({
  id: "aurora-agent",
  version,
  digest: "digest",
  active_now: false,
  active_after_restart: true,
  enabled_after_restart: true,
  restart_required: true,
  history: [],
  quarantine: [],
});
const themeEntry = (version: string) => ({
  id: "aurora-theme",
  name: "Aurora theme",
  version,
  sha256: "a".repeat(64),
  active: false,
  theme: null,
  error: null,
});

function listings(
  installed: Installed = {},
  rec: Record<string, string> = recommended,
  tabCatalog: Partial<ManagedThemeCatalogResponse> = {},
  catalog = index,
): MarketplaceListing[] {
  const tabInventory: ManagedTabInventoryEntry[] = installed.tab
    ? [{ id: "aurora-tab", name: "Aurora tab", version: installed.tab, error: null }]
    : [];
  return buildListings({
    providerCatalog: {
      source_configured: true,
      cache_status: "verified",
      refreshed: true,
      used_cached_verified_catalog: false,
      recommended_versions: rec,
      index: catalog,
    },
    providerInventory: installed.agent ? [agentEntry(installed.agent)] : [],
    themeCatalog: { verified: true, recommended_versions: rec, index: catalog },
    // The fixture skips the document: only the installed revision matters here.
    themeInventory: installed.theme ? [themeEntry(installed.theme) as never] : [],
    tabCatalog: { verified: true, recommended_versions: rec, index: catalog, ...tabCatalog },
    tabInventory,
  });
}
const plugin = (all: MarketplaceListing[]) => all.find((item) => item.key === "plugin:aurora")!;

describe("plugin listings", () => {
  it("lists one plugin with its member kinds, and members that know their plugin", () => {
    const all = listings();
    const aurora = plugin(all);
    expect(aurora).toMatchObject({
      kind: "plugin",
      name: "Aurora",
      publisher: "acme",
      contributes: ["provider", "tab", "theme"],
      recommended: "2.0.0",
      inCatalog: true,
      availableHere: true,
    });
    expect(aurora.installed).toBeUndefined();
    expect(aurora.versions.map((entry) => entry.version)).toEqual(["2.0.0", "1.0.0"]);
    for (const key of ["provider:aurora-agent", "tab:aurora-tab", "theme:aurora-theme"])
      expect(all.find((item) => item.key === key)?.partOf).toEqual({
        id: "aurora",
        name: "Aurora",
      });
  });

  it("recommends the newest release every member's recommendation reaches, else none", () => {
    expect(plugin(listings({}, { ...recommended, "aurora-tab": "1.0.0" })).recommended).toBe(
      "1.0.0",
    );
    const { "aurora-tab": _tab, ...withoutTab } = recommended;
    expect(plugin(listings({}, withoutTab)).recommended).toBeUndefined();
  });

  it("is installed when every member is at the plugin version, with an update from members", () => {
    const aurora = plugin(listings({ agent: "1.0.0", tab: "1.0.0", theme: "1.0.0" }));
    expect(aurora.installed).toMatchObject({ version: "1.0.0", partial: false });
    expect(aurora.installed?.restartRequired).toBe(true);
    expect(aurora.update).toBe("2.0.0");
  });

  it("is partial when a member is missing or at another version", () => {
    const missing = plugin(listings({ theme: "2.0.0" }));
    expect(missing.installed).toMatchObject({ version: "2.0.0", partial: true });
    expect(missing.update).toBeUndefined();
    const mixed = plugin(listings({ agent: "1.0.0", tab: "1.0.0", theme: "2.0.0" }));
    expect(mixed.installed).toMatchObject({ version: "1.0.0", partial: true });
    expect(mixed.update).toBe("2.0.0");
  });

  it("takes availability and revocations from its members' host verdicts", () => {
    const aurora = plugin(
      listings({}, recommended, {
        unavailable_versions: { "aurora-tab": { "2.0.0": "platform" } },
        blocked_versions: { "aurora-tab": { "1.0.0": "Leaks tokens" } },
      }),
    );
    expect(aurora.versions[0]).toMatchObject({ version: "2.0.0", unavailable: "platform" });
    expect(aurora.versions[1]).toMatchObject({ blocked: "Aurora tab: Leaks tokens" });
    expect(aurora.versions[1].unavailable).toBeUndefined();
  });

  it("needs a newer Cadencr when a release contributes a kind it does not know", () => {
    const future = signedCatalog([
      auroraPlugin("1.0.0"),
      auroraPlugin("2.0.0", [auroraTab("2.0.0"), { kind: "skill", package: {} }]),
    ]);
    // As the host would: the agent and theme exist only in 1.0.0.
    const rec = { "aurora-agent": "1.0.0", "aurora-tab": "2.0.0", "aurora-theme": "1.0.0" };
    const aurora = plugin(listings({}, rec, {}, future));
    expect(aurora.versions[0]).toMatchObject({ unavailable: "protocol", unknownKinds: ["skill"] });
    expect(aurora.versions[0].members).toEqual([{ kind: "tab", id: "aurora-tab" }]);
    // The newest release this build can install fully is the one recommended.
    expect(aurora.recommended).toBe("1.0.0");
  });

  it("plans the members a release still needs, in catalog order", () => {
    const all = listings({ theme: "1.0.0" });
    const aurora = plugin(all);
    const steps = pluginSteps(pluginMembers(aurora, "1.0.0", listingIndex(all)), "1.0.0");
    expect(steps.map((step) => step.ref.id)).toEqual(["aurora-agent", "aurora-tab"]);
    expect(pluginOffer(aurora, steps, "1.0.0")).toBe("complete");
    const update = pluginSteps(pluginMembers(aurora, "2.0.0", listingIndex(all)), "2.0.0");
    expect(update).toHaveLength(3);
    expect(pluginOffer(aurora, update, "2.0.0")).toBe("update");
    expect(pluginOffer(plugin(listings()), update, "2.0.0")).toBe("install");
  });

  it("recommends an older release when the newer one changed members and is not for this platform", () => {
    // 2.0.0 dropped the agent, and its tab ships no build here: the host recommends tab 1.0.0.
    const changed = signedCatalog([
      auroraPlugin("1.0.0"),
      auroraPlugin("2.0.0", [auroraTab("2.0.0"), auroraTheme("2.0.0")]),
    ]);
    const rec = { "aurora-agent": "1.0.0", "aurora-tab": "1.0.0", "aurora-theme": "2.0.0" };
    const aurora = plugin(
      listings(
        { agent: "1.0.0", tab: "1.0.0", theme: "1.0.0" },
        rec,
        { unavailable_versions: { "aurora-tab": { "2.0.0": "platform" } } },
        changed,
      ),
    );
    expect(aurora.versions[0]).toMatchObject({ version: "2.0.0", unavailable: "platform" });
    expect(aurora.recommended).toBe("1.0.0");
    expect(aurora.installed).toMatchObject({ version: "1.0.0", partial: false });
    expect(aurora.update).toBeUndefined();
  });

  it("ignores a member recommendation that is no release of the plugin", () => {
    // The theme also ships standalone at 1.5.0, which is all the host recommends for it.
    const catalog = signedCatalog([
      auroraPlugin("1.0.0"),
      auroraPlugin("2.0.0"),
      auroraTheme("1.5.0"),
    ]);
    const rec = { "aurora-agent": "2.0.0", "aurora-tab": "2.0.0", "aurora-theme": "1.5.0" };
    const aurora = plugin(listings({}, rec, {}, catalog));
    expect(aurora.versions.map((entry) => entry.version)).toEqual(["2.0.0", "1.0.0"]);
    expect(aurora.recommended).toBe("1.0.0");
  });

  it("never offers a release a member's kind catalog does not list yet", () => {
    // The tab catalog is an older snapshot that only knows the 1.0.0 release.
    const stale = { index: signedCatalog([auroraPlugin("1.0.0")]) };
    const aurora = plugin(listings({}, recommended, stale));
    expect(aurora.versions[0]).toMatchObject({ version: "2.0.0", incomplete: ["aurora-tab"] });
    expect(aurora.recommended).toBe("1.0.0");
    // Nothing loaded for tabs at all: no release installs whole.
    const failed = plugin(listings({}, recommended, { verified: false, index: null }));
    expect(failed.versions.every((entry) => entry.incomplete?.includes("aurora-tab"))).toBe(true);
    expect(failed.availableHere).toBe(false);
    expect(failed.recommended).toBeUndefined();
  });

  it("finds a plugin's installed members and keeps members out of standalone browsing", () => {
    const all = listings({ tab: "1.0.0", theme: "1.0.0" });
    const aurora = plugin(all);
    expect(installedPluginMembers(aurora, all).map((item) => item.key)).toEqual([
      "tab:aurora-tab",
      "theme:aurora-theme",
    ]);
    expect(all.filter(isStandalone).map((item) => item.key)).toEqual(["plugin:aurora"]);
  });

  it("lists the plugin beside its members, each under its own key", () => {
    const all = listings();
    expect(all.filter((item) => item.id.startsWith("aurora")).map((item) => item.key)).toEqual([
      "plugin:aurora",
      "provider:aurora-agent",
      "tab:aurora-tab",
      "theme:aurora-theme",
    ]);
  });
});

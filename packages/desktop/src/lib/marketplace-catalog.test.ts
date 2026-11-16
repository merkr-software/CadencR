import { describe, expect, it } from "vitest";
import {
  catalogMembers,
  catalogPlugins,
  groupTabPackages,
  signedMixedCatalogSchema,
} from "./marketplace-catalog";
import { providerCatalogPackages } from "./marketplace";
import {
  auroraAgent,
  auroraPlugin,
  auroraTab,
  auroraTheme,
  signedCatalog,
} from "./marketplace-plugin-fixtures";
import { groupThemePackages } from "./theme-marketplace";

const midnight = {
  ...auroraTheme("1.0.0"),
  package: {
    ...auroraTheme("1.0.0").package,
    theme: { ...auroraTheme("1.0.0").package.theme, id: "midnight", name: "Midnight" },
  },
};
const memberIds = (packages: unknown[]) =>
  catalogMembers(packages).map((entry) =>
    entry.kind === "theme"
      ? entry.package.theme.id
      : entry.kind === "tab"
        ? entry.package.tab.id
        : entry.kind === "lsp"
          ? entry.package.lsp.id
          : entry.package.agent.id,
  );

describe("signed catalog parsing", () => {
  it("accepts plugin entries and entries of kinds this build does not know", () => {
    const catalog = signedCatalog([
      auroraPlugin("1.0.0"),
      { kind: "skill", package: { skill: { id: "lint" } } },
      midnight,
    ]);
    expect(signedMixedCatalogSchema.safeParse(catalog).success).toBe(true);
  });

  it("accepts a plugin with a member of an unknown kind", () => {
    const plugin = auroraPlugin("1.0.0", [auroraTab("1.0.0"), { kind: "skill", package: {} }]);
    expect(signedMixedCatalogSchema.safeParse(signedCatalog([plugin])).success).toBe(true);
    expect(catalogPlugins([plugin])[0].contributes[1]).toEqual({
      kind: "unknown",
      declared: "skill",
    });
  });

  it("rejects assets on a plugin's own host: a plugin has no archive to hold them", () => {
    const plugin = auroraPlugin("1.0.0");
    const withIcon = {
      ...plugin,
      package: {
        ...plugin.package,
        host: { ...plugin.package.host, assets: { icon: "icon.png" } },
      },
    };
    expect(signedMixedCatalogSchema.safeParse(signedCatalog([plugin])).success).toBe(true);
    expect(signedMixedCatalogSchema.safeParse(signedCatalog([withIcon])).success).toBe(false);
  });

  it("parses one signed package list once, however many readers group it", () => {
    const packages = [auroraPlugin("1.0.0"), midnight];
    expect(catalogMembers(packages)[0]).toBe(catalogMembers(packages)[0]);
    expect(catalogPlugins(packages)[0]).toBe(catalogPlugins(packages)[0]);
  });

  it("still rejects a malformed known entry, a nested plugin, or an empty plugin", () => {
    const malformedTheme = { kind: "theme", package: auroraTab("1.0.0").package };
    const malformedMember = auroraPlugin("1.0.0", [malformedTheme]);
    const nested = auroraPlugin("1.0.0", [auroraPlugin("1.0.0")]);
    const empty = auroraPlugin("1.0.0", []);
    for (const entry of [malformedTheme, malformedMember, nested, empty])
      expect(signedMixedCatalogSchema.safeParse(signedCatalog([entry])).success).toBe(false);
  });
});

describe("catalog members", () => {
  it("flattens plugin members beside standalone entries, in catalog order", () => {
    expect(memberIds([auroraPlugin("1.0.0"), midnight])).toEqual([
      "aurora-agent",
      "aurora-tab",
      "aurora-theme",
      "midnight",
    ]);
  });

  it("skips unknown kinds at the top level and inside plugins", () => {
    const plugin = auroraPlugin("1.0.0", [auroraTab("1.0.0"), { kind: "skill", package: {} }]);
    expect(memberIds([{ kind: "skill", package: {} }, plugin])).toEqual(["aurora-tab"]);
  });

  it("feeds every kind's grouping, so a member installs like a standalone package", () => {
    const index = signedCatalog([auroraPlugin("1.0.0"), auroraPlugin("2.0.0"), midnight]);
    const themes = groupThemePackages({ verified: true, recommended_versions: {}, index });
    expect(themes.map((group) => group.map((item) => item.theme.version))).toEqual([
      ["1.0.0", "2.0.0"],
      ["1.0.0"],
    ]);
    const tabs = groupTabPackages({ verified: true, recommended_versions: {}, index });
    expect(tabs.get("aurora-tab")?.map((item) => item.tab.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(providerCatalogPackages(index)).toEqual([
      auroraAgent("1.0.0").package,
      auroraAgent("2.0.0").package,
    ]);
  });
});

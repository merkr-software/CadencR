import { describe, expect, it } from "vitest";
import { lspListings } from "./marketplace-lsp-listings";
import { lspCatalogSchema, type LspInventory } from "./lsp/marketplace";
import { catalogMembers, signedMixedCatalogSchema } from "./marketplace-catalog";
import { auroraPlugin, auroraTheme, signedCatalog } from "./marketplace-plugin-fixtures";
import { versionProblem } from "./marketplace-listing-base";
import { browsableListings } from "./marketplace-platform";
import {
  installedPluginMembers,
  listingIndex,
  pluginListings,
  pluginMembers,
  pluginSteps,
} from "./marketplace-plugin-listings";

const entry = (protocol = 1, runtime = "node") => ({
  kind: "lsp" as const,
  package: {
    lsp: {
      id: "custom-server",
      name: "Custom server",
      description: "Custom language tooling",
      version: "1.0.0",
      repository: "https://github.com/acme/custom",
      license: "MIT",
      protocol_version: protocol,
      languages: [{ id: "custom", extensions: ["custom"], filenames: ["Customfile"] }],
      root_markers: ["Customfile"],
      role: "general" as const,
      args: ["--stdio"],
      initialization_options: { custom: true },
      distribution: {
        binary: {
          "linux-x86_64": {
            archive: "https://github.com/acme/custom/releases/download/v1.0.0/server.tgz",
            sha256: "a".repeat(64),
            size: 200,
            entry: "server.js",
            entry_sha256: "b".repeat(64),
            entry_size: 100,
            runtime,
          },
        },
      },
    },
    host: { publisher: "acme", compatibility: { min_app_version: "0.15.0" } },
  },
});
const catalog = (overrides: object = {}, packages: unknown[] = [entry()]) =>
  lspCatalogSchema.parse({
    verified: true,
    index: signedCatalog(packages),
    recommended_versions: { "custom-server": "1.0.0" },
    ...overrides,
  });
const inventory: LspInventory = {
  servers: [
    {
      lsp_id: "custom-server",
      name: "Custom server",
      description: "",
      language_ids: ["custom"],
      languages: [],
      role: "general",
      status: "legacy",
      version: "1.0.0",
    },
  ],
};

describe("marketplace LSP listings", () => {
  it.each(["darwin-aarch64", "linux-x86_64"])(
    "uses host verdicts on %s without guessing from the browser OS",
    (host) => {
      const [listing] = lspListings(
        catalog({
          host_platform: host,
          unavailable_versions: { "custom-server": { "1.0.0": "platform" } },
          recommended_versions: {},
        }),
      );
      expect(listing.availableHere).toBe(false);
      expect(browsableListings([listing])).toEqual([]);
    },
  );

  it.each([
    ["protocol", "outdated"],
    ["node", "runtime"],
    ["policy", "policy"],
    ["compatibility", "compatibility"],
  ])("preserves the %s install restriction", (reason, problem) => {
    const [listing] = lspListings(
      catalog({
        unavailable_versions: { "custom-server": { "1.0.0": reason } },
        recommended_versions: {},
      }),
    );
    expect(versionProblem(listing.versions[0])).toBe(problem);
    expect(listing.availableHere).toBe(false);
  });

  it("blocks revoked versions and propagates every member restriction to a plugin", () => {
    const plugin = auroraPlugin("1.0.0", [entry()]);
    const source = catalog(
      { blocked_versions: { "custom-server": { "1.0.0": "Unsafe release" } } },
      [plugin],
    );
    const members = lspListings(source);
    const [bundle] = pluginListings([source.index?.signed.packages], members);
    expect(bundle.versions[0].blocked).toContain("Unsafe release");
    expect(bundle.availableHere).toBe(false);
    const nodeSource = catalog({ unavailable_versions: { "custom-server": { "1.0.0": "node" } } }, [
      plugin,
    ]);
    expect(
      pluginListings([nodeSource.index?.signed.packages], lspListings(nodeSource))[0].versions[0]
        .unavailable,
    ).toBe("node");
  });

  it("retains installed tools offline and distinguishes managed from external installations", () => {
    const [listing] = lspListings(undefined, inventory);
    expect(listing.installed).toMatchObject({ version: "1.0.0", managed: false, usable: true });
    expect(listing.inCatalog).toBe(false);
  });

  it("keeps invalid managed installations manageable without trusting their metadata", () => {
    const [listing] = lspListings(undefined, {
      servers: [
        {
          ...inventory.servers[0],
          status: "invalid",
          version: null,
          error: "Revocation policy expired",
        },
      ],
    });
    expect(listing.installed).toMatchObject({
      managed: true,
      usable: false,
      version: null,
      error: "Revocation policy expired",
    });
  });

  it("still installs a managed plugin member when an external server has the same version", () => {
    const source = catalog({}, [auroraPlugin("1.0.0", [entry()])]);
    const [member] = lspListings(source, inventory);
    member.partOf = { id: "aurora", name: "Aurora" };
    const [bundle] = pluginListings([source.index?.signed.packages], [member]);
    const steps = pluginSteps(pluginMembers(bundle, "1.0.0", listingIndex([member])), "1.0.0");
    expect(steps).toHaveLength(1);
    expect(bundle.installed?.partial).toBe(true);
    expect(installedPluginMembers(bundle, [member])).toEqual([]);
  });

  it("keeps themes and supported tools visible beside future protocol/runtime declarations", () => {
    const supported = entry();
    const future = entry(2, "future-runtime");
    future.package.lsp.id = "future-server";
    const signed = signedCatalog([auroraTheme("1.0.0"), supported, future]);
    expect(signedMixedCatalogSchema.safeParse(signed).success).toBe(true);
    expect(catalogMembers(signed.signed.packages).map((member) => member.kind)).toEqual([
      "theme",
      "lsp",
      "lsp",
    ]);
  });
});

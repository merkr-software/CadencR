import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_IDS } from "@/lib/providers";
import { providerAccessModeConfig } from "@/lib/provider-access-modes";
import { setProviderCatalogMetadata } from "@/lib/provider-catalog-registry";

const ACCESS_MODES = [
  { id: "default" as const, label: "Ask" },
  { id: "fullAccess" as const, label: "Full access" },
];

describe("providerAccessModeConfig", () => {
  afterEach(() => setProviderCatalogMetadata([]));
  it("keeps the Codex default provider-scoped", () => {
    expect(providerAccessModeConfig(PROVIDER_IDS.CODEX_CLI)?.settingKey).toBe(
      "codex_permission_mode",
    );
    expect(providerAccessModeConfig(PROVIDER_IDS.CODEX_CLI)?.providerLabel).toBe("Codex");
  });

  it("gives a catalog-declared access axis the generic per-provider setting", () => {
    expect(
      providerAccessModeConfig("cursor", {
        label: "Cursor",
        accessModes: ACCESS_MODES,
      }),
    ).toEqual({
      providerLabel: "Cursor",
      settingKey: "provider_access_mode.cursor",
    });
  });

  it("reads the published catalog when no entry is passed", () => {
    setProviderCatalogMetadata([{ id: "acme", label: "Acme", access_modes: ACCESS_MODES }]);
    expect(providerAccessModeConfig("acme")?.settingKey).toBe("provider_access_mode.acme");
  });

  it("rejects providers without at least two access modes", () => {
    expect(providerAccessModeConfig(PROVIDER_IDS.CLAUDE_CODE)).toBeNull();
    expect(providerAccessModeConfig("cursor")).toBeNull();
    expect(
      providerAccessModeConfig("cursor", {
        label: "Cursor",
        accessModes: ACCESS_MODES.slice(1),
      }),
    ).toBeNull();
    expect(providerAccessModeConfig(undefined)).toBeNull();
  });
});

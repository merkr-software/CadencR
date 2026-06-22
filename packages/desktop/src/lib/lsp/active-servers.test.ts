import { describe, expect, it } from "vitest";
import { resolveActiveServers, DEFAULT_TS_SERVER } from "./active-servers";

describe("resolveActiveServers", () => {
  it("returns the default TS server when nothing is configured", () => {
    expect(resolveActiveServers("typescript", { typescriptServer: null, linter: null })).toEqual([
      DEFAULT_TS_SERVER,
    ]);
  });

  it("selects tsgo when chosen", () => {
    expect(
      resolveActiveServers("typescriptreact", { typescriptServer: "tsgo", linter: "off" }),
    ).toEqual(["tsgo"]);
  });

  it("appends the linter after the type checker, in order", () => {
    expect(
      resolveActiveServers("typescript", {
        typescriptServer: "typescript-language-server",
        linter: "biome",
      }),
    ).toEqual(["typescript-language-server", "biome"]);
  });

  it("keeps the type checker first so navigation targets it", () => {
    const ids = resolveActiveServers("javascript", {
      typescriptServer: "tsgo",
      linter: "eslint",
    });
    expect(ids?.[0]).toBe("tsgo");
    expect(ids).toContain("eslint");
  });

  it("ignores an unknown / off linter", () => {
    expect(
      resolveActiveServers("typescript", { typescriptServer: null, linter: "tslint" }),
    ).toEqual([DEFAULT_TS_SERVER]);
    expect(resolveActiveServers("typescript", { typescriptServer: null, linter: "off" })).toEqual([
      DEFAULT_TS_SERVER,
    ]);
  });

  it("returns null for non-JS/TS languages (use the default server)", () => {
    expect(resolveActiveServers("rust", { typescriptServer: "tsgo", linter: "biome" })).toBeNull();
    expect(resolveActiveServers("python", { typescriptServer: null, linter: null })).toBeNull();
    expect(resolveActiveServers("json", { typescriptServer: null, linter: "biome" })).toBeNull();
  });
});

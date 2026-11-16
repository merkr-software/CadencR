import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";

const exampleDir = fileURLToPath(new URL("../example/", import.meta.url));
let css = "";

beforeAll(async () => {
  await build({ configFile: `${exampleDir}vite.config.ts`, logLevel: "silent" });
  const assets = `${exampleDir}dist/assets/`;
  const file = readdirSync(assets).find((name) => name.endsWith(".css"));
  if (!file) throw new Error("the example build emitted no stylesheet");
  css = readFileSync(assets + file, "utf8");
});

describe("example consumer", () => {
  it.each([
    [".bg-primary", "a utility from the example's own markup"],
    [".text-muted-foreground", "a token colour utility"],
    [".bg-popover", "a class only the bundled components use (via @source dist)"],
    ["zoom-in-95", "tw-animate utilities the components use"],
    [".bg-surface-sunken", "the kit-native Card surface"],
    [".text-numstat-add-fg", "a line-count utility"],
    [".bg-diff-del-bg", "a diff-row utility"],
    ["--cadencr-background:#131416", "tokens.css defaults"],
    ["Inter Variable", "the bundled UI font"],
  ])("emits %s (%s)", (needle) => {
    expect(css).toContain(needle);
  });

  it("resolves theme utilities to --cadencr-* properties", () => {
    expect(css).toMatch(/\.bg-primary[^{]*\{background-color:var\(--cadencr-primary\)/);
    expect(css).toMatch(/\.text-numstat-add-fg[^{]*\{color:var\(--cadencr-numstat-add-fg\)/);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKENS_CSS, readTokenKeys, renderTokensCss } from "../scripts/generate-tokens.mjs";

const tokensCss = readFileSync(TOKENS_CSS, "utf8");

function block(selectorStart: string): string {
  const at = tokensCss.indexOf(selectorStart);
  expect(at, `${selectorStart} block`).toBeGreaterThanOrEqual(0);
  return tokensCss.slice(at, tokensCss.indexOf("}", at));
}

describe("tokens.css", () => {
  const { required, optional } = readTokenKeys();

  it("parses the desktop token vocabulary", () => {
    expect(required).toContain("--background");
    expect(required).toContain("--sidebar-ring");
    expect(optional).toContain("--tab-track-bg");
  });

  it.each([
    [":root,", "dark"],
    [':root[data-appearance="light"]', "light"],
  ])("declares every theme token in the %s (%s) block", (selector) => {
    const body = block(selector);
    const missing = [...required, ...optional].filter(
      (key) => !body.includes(`--cadencr-${key.slice(2)}:`),
    );
    expect(missing).toEqual([]);
  });

  it("is up to date with the desktop CadencR themes", () => {
    expect(tokensCss).toBe(renderTokensCss());
  });

  it("only references tokens it defines", () => {
    const preset = readFileSync(new URL("../preset.css", import.meta.url), "utf8");
    const defined = new Set(
      [...(tokensCss + preset).matchAll(/(--cadencr-[a-z0-9-]+):/g)].map((m) => m[1]),
    );
    const referenced = [...(tokensCss + preset).matchAll(/var\((--cadencr-[a-z0-9-]+)\)/g)].map(
      (m) => m[1],
    );
    expect(referenced.filter((name) => !defined.has(name))).toEqual([]);
  });
});

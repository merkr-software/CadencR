import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOC_SECTIONS } from "./docs";

describe("documentation navigation", () => {
  it("lists every guide exactly once", () => {
    const guideSlugs = readdirSync(new URL("../pages/docs/", import.meta.url))
      .filter((file) => file.endsWith(".mdx"))
      .map((file) => (file === "index.mdx" ? "" : file.slice(0, -4)));
    const navigationSlugs = DOC_SECTIONS.flatMap((section) =>
      section.pages.map((page) => page.slug),
    );

    expect(new Set(navigationSlugs).size).toBe(navigationSlugs.length);
    expect(navigationSlugs.toSorted()).toEqual(guideSlugs.toSorted());
  });
});

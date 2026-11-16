import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const kitRoot = new URL("../", import.meta.url);
const desktopSrc = new URL("../../desktop/src/", import.meta.url);

/** Third-party modules a re-exported component may import (bundled or peer). */
const ALLOWED_PACKAGES = new Set([
  "react",
  "radix-ui",
  "class-variance-authority",
  "lucide-react",
  "clsx",
  "tailwind-merge",
]);

function specifiers(source: string): string[] {
  return [...source.matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
}

function desktopFile(alias: string): URL {
  const base = alias.replace(/^@\//, "");
  const candidate = [".tsx", ".ts"]
    .map((ext) => new URL(base + ext, desktopSrc))
    .find((url) => existsSync(url));
  if (!candidate) throw new Error(`Cannot find desktop module ${alias}`);
  return candidate;
}

describe("re-exported desktop modules", () => {
  const index = readFileSync(new URL("src/index.ts", kitRoot), "utf8");
  const reexported = specifiers(index);

  const desktopModules = reexported.filter((s) => s.startsWith("@/"));
  const kitModules = reexported.filter((s) => !s.startsWith("@/"));

  it("are desktop modules or kit-native primitives", () => {
    expect(desktopModules.length).toBeGreaterThan(10);
    expect(kitModules.sort()).toEqual(["./card", "./empty-state", "./label"]);
  });

  it.each(desktopModules)("%s imports no app-only module", (alias) => {
    const imports = specifiers(readFileSync(desktopFile(alias), "utf8"));
    const offending = imports.filter((s) =>
      s.startsWith("@/")
        ? s !== "@/lib/utils" && !desktopModules.includes(s)
        : !ALLOWED_PACKAGES.has(s),
    );
    expect(offending).toEqual([]);
  });
});

describe("dist/index.js", () => {
  const bundle = readFileSync(new URL("dist/index.js", kitRoot), "utf8");

  it("keeps only React external", () => {
    const external = new Set(
      [...bundle.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]),
    );
    expect([...external].every((s) => /^react(-dom)?($|\/)/.test(s))).toBe(true);
  });

  it("renders desktop components with their token classes", async () => {
    const kit = await import(new URL("dist/index.js", kitRoot).href);
    const html = renderToStaticMarkup(createElement(kit.Button, { variant: "default" }, "Go"));
    expect(html).toContain("bg-primary");
    expect(html).toContain('data-slot="button"');
    expect(kit.cn("p-2", "p-4")).toBe("p-4");
  });

  it("renders the kit-native primitives with token classes", async () => {
    const kit = await import(new URL("dist/index.js", kitRoot).href);
    const card = renderToStaticMarkup(
      createElement(
        kit.Card,
        null,
        createElement(
          kit.CardHeader,
          null,
          createElement(kit.CardTitle, null, "Pipelines"),
          createElement(kit.CardDescription, null, "Last run"),
        ),
        createElement(kit.CardContent, null, "body"),
        createElement(kit.CardFooter, null, "footer"),
      ),
    );
    expect(card).toContain('data-slot="card"');
    expect(card).toContain("bg-surface-sunken");
    expect(card).toContain("rounded-xl");
    expect(card).toContain("text-muted-foreground");
    expect(card).toContain('data-slot="card-footer"');
    const label = renderToStaticMarkup(createElement(kit.Label, { htmlFor: "x" }, "Name"));
    expect(label).toBe(
      '<label data-slot="label" class="flex items-center gap-2 text-sm leading-none font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50" for="x">Name</label>',
    );
    const empty = renderToStaticMarkup(
      createElement(kit.EmptyState, {
        icon: createElement("svg"),
        title: "No changes",
        description: "This feature has no changed files yet.",
        action: createElement(kit.Button, null, "Refresh"),
      }),
    );
    expect(empty).toContain("No changes");
    expect(empty).toContain("<svg>");
    expect(empty).toContain('data-slot="button"');
  });

  it("ships the fonts fonts.css points at", () => {
    const fonts = readFileSync(new URL("fonts.css", kitRoot), "utf8");
    const urls = [...fonts.matchAll(/url\("\.\/([^"]+)"\)/g)].map((m) => m[1]!);
    expect(urls.length).toBe(7);
    for (const url of urls) expect(existsSync(new URL(url, kitRoot)), url).toBe(true);
  });
});

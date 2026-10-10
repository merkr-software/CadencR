// @vitest-environment jsdom
// Pinned to jsdom: Mermaid-to-Excalidraw conversion needs jsdom's SVG support.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fromDesktop = createRequire(path.resolve(process.cwd(), "package.json"));

const originalGetBBox = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");

beforeAll(() => {
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => new DOMRect(0, 0, 100, 20),
  });
});

afterAll(() => {
  if (originalGetBBox) {
    Object.defineProperty(SVGElement.prototype, "getBBox", originalGetBBox);
  } else {
    Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  }
});

function nanoidPathsFor(consumer: string): { secure: string; nonSecure: string } {
  const fromConsumer = createRequire(fromDesktop.resolve(consumer));
  return {
    secure: fromConsumer.resolve("nanoid"),
    nonSecure: fromConsumer.resolve("nanoid/non-secure"),
  };
}

interface MermaidConverterModule {
  parseMermaidToExcalidraw(
    definition: string,
  ): Promise<{ elements: Array<{ id: string; type: string }> }>;
}

async function loadMermaidConverter(): Promise<MermaidConverterModule> {
  const fromExcalidraw = createRequire(fromDesktop.resolve("@excalidraw/excalidraw"));
  const modulePath = fromExcalidraw.resolve("@excalidraw/mermaid-to-excalidraw");
  const dependency: unknown = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
  if (
    typeof dependency !== "object" ||
    dependency === null ||
    !("parseMermaidToExcalidraw" in dependency) ||
    typeof dependency.parseMermaidToExcalidraw !== "function"
  ) {
    throw new Error("Excalidraw's Mermaid converter did not export its parser");
  }
  return dependency as MermaidConverterModule;
}

function exerciseNanoidInSubprocess(consumer: string): ReturnType<typeof spawnSync> {
  const paths = nanoidPathsFor(consumer);
  const script = `
    const secure = await import(${JSON.stringify(pathToFileURL(paths.secure).href)});
    const nonSecure = await import(${JSON.stringify(pathToFileURL(paths.nonSecure).href)});
    secure.customAlphabet("abc", 0)();
    nonSecure.nanoid(-1);
    let rejectedOversize = false;
    try {
      secure.nanoid(2147483648);
    } catch (error) {
      rejectedOversize = error instanceof RangeError;
    }
    if (!rejectedOversize) process.exit(3);
    const first = secure.nanoid();
    const second = secure.nanoid();
    if (first === second || /^u+$/.test(first) || /^u+$/.test(second)) process.exit(2);
  `;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("Excalidraw dependency integration", () => {
  it("converts a valid Mermaid diagram into distinct editable elements", async () => {
    const { parseMermaidToExcalidraw } = await loadMermaidConverter();
    const { elements } = await parseMermaidToExcalidraw("flowchart LR\n  A[Start] --> B[Finish]");

    expect(elements.length).toBeGreaterThanOrEqual(3);
    expect(new Set(elements.map((element) => element.id)).size).toBe(elements.length);
    expect(elements.some((element) => element.type === "arrow")).toBe(true);
  });

  it.each(["@excalidraw/excalidraw", "@excalidraw/mermaid-to-excalidraw"])(
    "bounds malicious Nano ID sizes used by %s without corrupting later IDs",
    (consumer) => {
      const result = exerciseNanoidInSubprocess(consumer);
      const diagnostic = String(result.stderr);
      expect(result.error, diagnostic).toBeUndefined();
      expect(result.status, diagnostic).toBe(0);
    },
  );
});

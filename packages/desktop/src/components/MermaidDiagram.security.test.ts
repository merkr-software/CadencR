// @vitest-environment jsdom
// Pinned to jsdom: sanitization must run against a spec-faithful DOM (DOMPurify behaves differently in happy-dom).
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface DOMPurifyInstance {
  addHook(name: "uponSanitizeElement", hook: (node: Node) => void): void;
  removeAllHooks(): void;
  sanitize(node: Node): Node;
  setConfig(config: { ALLOWED_TAGS: string[]; IN_PLACE: boolean }): void;
}

type DOMPurifyFactory = (window: Window) => DOMPurifyInstance;

function mermaidDOMPurify(): DOMPurifyInstance {
  const fromDesktop = createRequire(path.resolve(process.cwd(), "package.json"));
  const fromMermaid = createRequire(fromDesktop.resolve("mermaid"));
  const dependency: unknown = fromMermaid("dompurify");
  if (typeof dependency !== "function") throw new Error("DOMPurify did not export a factory");
  return (dependency as DOMPurifyFactory)(window);
}

describe("Mermaid DOMPurify integration", () => {
  it("neutralizes descendants when a sanitization hook detaches their parent", () => {
    const purifier = mermaidDOMPurify();
    const root = document.createElement("div");
    root.innerHTML = '<footer><img src="x" onerror="window.__xss = true"></footer><div>safe</div>';
    const detachedImage = root.querySelector("img");
    if (!detachedImage) throw new Error("malicious image fixture was not created");

    purifier.setConfig({ ALLOWED_TAGS: ["div", "#text", "footer"], IN_PLACE: true });
    purifier.addHook("uponSanitizeElement", (node) => {
      if (node instanceof HTMLElement && node.tagName === "FOOTER") node.remove();
    });

    try {
      purifier.sanitize(root);
      expect(root.innerHTML).toBe("<div>safe</div>");
      expect(detachedImage).not.toHaveAttribute("onerror");
    } finally {
      purifier.removeAllHooks();
    }
  });
});

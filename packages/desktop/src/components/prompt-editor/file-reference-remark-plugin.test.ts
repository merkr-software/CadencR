import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, Link, Text } from "mdast";
import { describe, expect, it } from "vitest";
import { fileReferenceRemarkPlugin } from "./file-reference-remark-plugin";

function runSync(markdown: string): Root {
  const processor = unified().use(remarkParse).use(fileReferenceRemarkPlugin);
  return processor.runSync(processor.parse(markdown)) as Root;
}

function collectLinks(tree: Root): Link[] {
  const links: Link[] = [];
  function walk(node: unknown): void {
    if (node && typeof node === "object" && "type" in node) {
      const typed = node as { type: string; children?: unknown[] };
      if (typed.type === "link") links.push(typed as unknown as Link);
      typed.children?.forEach(walk);
    }
  }
  walk(tree);
  return links;
}

describe("fileReferenceRemarkPlugin", () => {
  it("turns a bare file reference into a link", () => {
    const tree = runSync("see src/main.rs:42 for details");
    const links = collectLinks(tree);
    expect(links).toHaveLength(1);
    expect(links[0].url).toContain("cadencr-file:");
    expect((links[0].children[0] as Text).value).toBe("src/main.rs:42");
  });

  it("preserves surrounding text as sibling text nodes", () => {
    const tree = runSync("see src/main.rs:42 for details");
    const paragraph = tree.children[0] as { children: Array<{ type: string; value?: string }> };
    const values = paragraph.children.map((node) => (node.type === "text" ? node.value : "[link]"));
    expect(values.join("")).toContain("see ");
    expect(values.join("")).toContain(" for details");
  });

  it("links multiple references in the same paragraph", () => {
    const tree = runSync("compare src/a.ts:1 against src/b.ts:2");
    expect(collectLinks(tree)).toHaveLength(2);
  });

  it("does not touch text already inside a markdown link", () => {
    const tree = runSync("[see src/main.rs:42](https://example.com)");
    const links = collectLinks(tree);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe("https://example.com");
  });

  it("does not touch inline code", () => {
    const tree = runSync("run `src/main.rs:42` as a path example");
    expect(collectLinks(tree)).toHaveLength(0);
  });

  it("does not touch fenced code blocks", () => {
    const tree = runSync("```\nsrc/main.rs:42\n```");
    expect(collectLinks(tree)).toHaveLength(0);
  });

  it("leaves text with no file reference untouched", () => {
    const tree = runSync("nothing to see here");
    expect(collectLinks(tree)).toHaveLength(0);
  });
});

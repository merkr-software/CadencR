// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  captureSelectionSnapshot,
  fragmentToMarkdown,
  selectionSnapshotToMarkdown,
} from "./selection-to-markdown";

/** Build a `DocumentFragment` from an HTML string (mirrors `range.cloneContents`). */
function fragment(html: string): DocumentFragment {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return tpl.content;
}

describe("fragmentToMarkdown", () => {
  it("re-emits unordered list bullets", () => {
    expect(fragmentToMarkdown(fragment("<ul><li>one</li><li>two</li></ul>"))).toBe("- one\n- two");
  });

  it("re-emits ordered list numbering", () => {
    expect(fragmentToMarkdown(fragment("<ol><li>a</li><li>b</li></ol>"))).toBe("1. a\n2. b");
  });

  it("indents nested lists", () => {
    const html = "<ul><li>parent<ul><li>child</li></ul></li></ul>";
    expect(fragmentToMarkdown(fragment(html))).toBe("- parent\n  - child");
  });

  it("re-emits headings with the right number of hashes", () => {
    expect(fragmentToMarkdown(fragment("<h1>Title</h1><h3>Sub</h3>"))).toBe("# Title\n\n### Sub");
  });

  it("preserves bold, italic, and strikethrough", () => {
    const html = "<p><strong>bold</strong> and <em>italic</em> and <del>gone</del></p>";
    expect(fragmentToMarkdown(fragment(html))).toBe("**bold** and *italic* and ~~gone~~");
  });

  it("re-emits inline code with backticks", () => {
    expect(fragmentToMarkdown(fragment("<p>see <code>foo()</code> here</p>"))).toBe(
      "see `foo()` here",
    );
  });

  it("re-emits fenced code blocks", () => {
    expect(fragmentToMarkdown(fragment("<pre><code>const x = 1;\n</code></pre>"))).toBe(
      "```\nconst x = 1;\n```",
    );
  });

  it("re-emits links with their href", () => {
    expect(fragmentToMarkdown(fragment('<p>see <a href="https://x.com">site</a></p>'))).toBe(
      "see [site](https://x.com)",
    );
  });

  it("re-emits blockquotes", () => {
    expect(fragmentToMarkdown(fragment("<blockquote><p>hello</p></blockquote>"))).toBe("> hello");
  });

  it("re-emits horizontal rules", () => {
    expect(fragmentToMarkdown(fragment("<p>a</p><hr><p>b</p>"))).toBe("a\n\n---\n\nb");
  });

  it("falls back to plain text for unknown tags", () => {
    expect(fragmentToMarkdown(fragment("<span>plain</span>"))).toBe("plain");
  });

  it("preserves bullets even when the selection clones a partial <ul>", () => {
    // Selecting from inside the first <li> through inside the second <li>
    // produces a fragment without the enclosing <ul>; the walker should
    // still mark each <li> with `- `.
    expect(fragmentToMarkdown(fragment("<li>one</li><li>two</li>"))).toBe("- one\n- two");
  });
});

describe("selection snapshots", () => {
  it("preserves ranges and derives Markdown after the live selection is cleared", () => {
    const heading = document.createElement("h2");
    heading.textContent = "Deferred heading";
    document.body.append(heading);
    const range = document.createRange();
    range.selectNode(heading);
    const selection = window.getSelection();
    selection?.addRange(range);

    const snapshot = captureSelectionSnapshot(selection!);
    selection?.removeAllRanges();

    expect(selectionSnapshotToMarkdown(snapshot)).toBe("## Deferred heading");
    heading.remove();
  });
});

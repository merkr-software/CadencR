/**
 * remark plugin: turns `path/to/file.ext[:line[:col]]` patterns found in
 * prose text nodes into `cadencr-file:` links, the same way a hand-written
 * markdown link would render — so `Markdown.tsx`'s existing link-rendering
 * path (see `cadencr-conversation:` handling) picks them up unchanged.
 */

import { visit } from "unist-util-visit";
import type { Link, Parent, Root, Text } from "mdast";
import { fileReferenceHref, parseFileReferences, type FileReferenceMatch } from "./file-reference";

// Node types whose text content must never be turned into a reference: an
// existing link's own label, or code (inline or fenced) where a path is
// almost always meant to be read verbatim, not clicked.
const SKIP_PARENT_TYPES = new Set(["link", "linkReference", "code", "inlineCode"]);

function buildReplacementNodes(value: string, matches: FileReferenceMatch[]): Array<Text | Link> {
  const nodes: Array<Text | Link> = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, match.start) });
    }
    nodes.push({
      type: "link",
      url: fileReferenceHref(match.path, match.line, match.col),
      children: [{ type: "text", value: value.slice(match.start, match.end) }],
    });
    cursor = match.end;
  }
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

export function fileReferenceRemarkPlugin() {
  return (tree: Root): void => {
    visit(tree, "text", (node: Text, index, parent: Parent | null | undefined) => {
      if (!parent || index === undefined || index === null) return;
      if (SKIP_PARENT_TYPES.has(parent.type)) return;

      const matches = parseFileReferences(node.value);
      if (matches.length === 0) return;

      const replacement = buildReplacementNodes(node.value, matches);
      parent.children.splice(index, 1, ...replacement);
      // Resume traversal after the inserted nodes: unist-util-visit lets a
      // visitor return the next index to visit, which skips re-scanning the
      // freshly inserted text/link nodes as if they were original content.
      return index + replacement.length;
    });
  };
}

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isTextNode,
  createEditor,
  TextNode,
  type LexicalEditor,
} from "lexical";
import { describe, expect, it } from "vitest";
import { normalizeUnifiedAgentsFilterTextNode } from "@/components/UnifiedAgentsFilterEditorText";

const TOKEN_MARKER = "--unified-agents-filter-token";

function createFilterEditor(): LexicalEditor {
  const editor = createEditor({
    onError: (error: Error): never => {
      throw error;
    },
  });
  editor.registerNodeTransform(TextNode, normalizeUnifiedAgentsFilterTextNode);
  return editor;
}

/** Writes raw text nodes as typing leaves them, bypassing the token-aware writer. */
function writeNodes(editor: LexicalEditor, texts: string[]): void {
  editor.update(
    () => {
      const paragraph = $createParagraphNode();
      for (const text of texts) paragraph.append($createTextNode(text));
      $getRoot().clear().append(paragraph);
    },
    { discrete: true },
  );
}

function readNodes(editor: LexicalEditor): { text: string; chip: boolean }[] {
  return editor.getEditorState().read(() =>
    $getRoot()
      .getAllTextNodes()
      .filter($isTextNode)
      .map((node) => ({
        text: node.getTextContent(),
        chip: node.getStyle().includes(TOKEN_MARKER),
      })),
  );
}

describe("normalizeUnifiedAgentsFilterTextNode", () => {
  it("turns a token typed after an earlier chip into its own chip", () => {
    const editor = createFilterEditor();
    writeNodes(editor, ["/last:20", " /sort:attention review"]);

    expect(readNodes(editor)).toEqual([
      { text: "/last:20", chip: true },
      { text: " ", chip: false },
      { text: "/sort:attention", chip: true },
      { text: " review", chip: false },
    ]);
  });

  it("leaves plain search text in one unstyled node", () => {
    const editor = createFilterEditor();
    writeNodes(editor, ["review payment"]);

    expect(readNodes(editor)).toEqual([{ text: "review payment", chip: false }]);
  });

  it("folds a character typed onto a chip back into it", () => {
    const editor = createFilterEditor();
    writeNodes(editor, ["/last:a", "ll"]);

    expect(readNodes(editor)).toEqual([{ text: "/last:all", chip: true }]);
  });
});

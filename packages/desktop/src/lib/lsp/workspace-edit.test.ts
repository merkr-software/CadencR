import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

type ViewStub = { getView: () => EditorView | null };
let openViews: Record<string, ViewStub | undefined> = {};

vi.mock("@codemirror/lsp-client", () => ({
  LSPPlugin: {
    get: () => ({
      uri: "file:///workspace/src/a.ts",
      client: { workspace: { getFile: (uri: string) => openViews[uri] ?? null } },
    }),
  },
}));

import { applyEditsToText, applyWorkspaceEdit, type WorkspaceEditHost } from "./workspace-edit";
import type { LspTextEdit } from "./workspace-edit";

const TEXT = "const foo = 1;\nconst bar = foo + foo;\n";

function doc(text: string) {
  return EditorState.create({ doc: text }).doc;
}

function view(text: string): EditorView {
  return new EditorView({ state: EditorState.create({ doc: text }) });
}

// Rename `foo` -> `xyz`: three occurrences across two lines.
const fooEdits: LspTextEdit[] = [
  { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: "xyz" },
  { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 15 } }, newText: "xyz" },
  { range: { start: { line: 1, character: 18 }, end: { line: 1, character: 21 } }, newText: "xyz" },
];

describe("applyEditsToText", () => {
  it("applies multiple edits on the same/different lines correctly", () => {
    const result = applyEditsToText(doc(TEXT), fooEdits);
    expect(result).toBe("const xyz = 1;\nconst bar = xyz + xyz;\n");
  });

  it("is order-independent (edits applied end-to-start)", () => {
    const reversed = [...fooEdits].reverse();
    expect(applyEditsToText(doc(TEXT), reversed)).toBe(applyEditsToText(doc(TEXT), fooEdits));
  });

  it("clamps an out-of-range position instead of throwing", () => {
    const edits: LspTextEdit[] = [
      {
        range: { start: { line: 99, character: 0 }, end: { line: 99, character: 3 } },
        newText: "x",
      },
    ];
    expect(() => applyEditsToText(doc(TEXT), edits)).not.toThrow();
  });
});

describe("applyWorkspaceEdit", () => {
  it("dispatches a transaction + saves for open files, read/writes closed ones", async () => {
    openViews = {};
    const openView = view(TEXT);
    openViews["file:///workspace/src/a.ts"] = { getView: () => openView };

    const saved: string[] = [];
    const written: Array<{ path: string; content: string }> = [];
    const host: WorkspaceEditHost = {
      saveOpenFile: async (uri) => {
        saved.push(uri);
      },
      readFileText: async () => "let foo = 2;\n",
      writeFileText: async (path, content) => {
        written.push({ path, content });
      },
    };

    const result = await applyWorkspaceEdit(
      openView,
      {
        changes: {
          "file:///workspace/src/a.ts": fooEdits,
          "file:///workspace/src/b.ts": [
            {
              range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } },
              newText: "xyz",
            },
          ],
        },
      },
      host,
    );

    expect(result.fileCount).toBe(2);
    // Open file: edited in place + saved.
    expect(openView.state.doc.toString()).toBe("const xyz = 1;\nconst bar = xyz + xyz;\n");
    expect(saved).toEqual(["file:///workspace/src/a.ts"]);
    // Closed file: read, edited, written.
    expect(written).toEqual([{ path: "/workspace/src/b.ts", content: "let xyz = 2;\n" }]);
    openView.destroy();
  });

  it("merges `changes` and `documentChanges`", async () => {
    openViews = {};
    const v = view(TEXT);
    const written: Array<{ path: string; content: string }> = [];
    const host: WorkspaceEditHost = {
      saveOpenFile: async () => {},
      readFileText: async () => "foo\n",
      writeFileText: async (path, content) => {
        written.push({ path, content });
      },
    };
    const result = await applyWorkspaceEdit(
      v,
      {
        documentChanges: [
          {
            textDocument: { uri: "file:///workspace/src/c.ts" },
            edits: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
                newText: "bar",
              },
            ],
          },
        ],
      },
      host,
    );
    expect(result.fileCount).toBe(1);
    expect(written).toEqual([{ path: "/workspace/src/c.ts", content: "bar\n" }]);
    v.destroy();
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { applyDocumentChanges } from "../../plugins/lsp/vue-language-server/bridge/typescript-features.mjs";

test("Vue incremental edits retain the open document and preserve UTF-16 coordinates", () => {
  const sent = [];
  const ts = { notify: (command, args) => sent.push({ command, args }) };
  const document = { text: "// 😀\r\nconst value: string = 42;\r\nvalue;\r\n" };
  applyDocumentChanges(ts, "/workspace/example.vue", document, [
    { range: { start: { line: 1, character: 22 }, end: { line: 1, character: 24 } }, text: '"ok"' },
    { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } }, text: "é" },
  ]);
  assert.deepEqual(sent, [
    { command: "change", args: { file: "/workspace/example.vue", line: 2, offset: 23,
      endLine: 2, endOffset: 25, insertString: '"ok"' } },
    { command: "change", args: { file: "/workspace/example.vue", line: 1, offset: 4,
      endLine: 1, endOffset: 6, insertString: "é" } },
  ]);
  assert.equal(document.text, '// é\r\nconst value: string = "ok";\r\nvalue;\r\n');
});

test("Vue full replacements and subsequent incremental edits use the latest document extent", () => {
  const sent = [];
  const ts = { notify: (command, args) => sent.push({ command, args }) };
  const document = { text: "first\nlast" };
  applyDocumentChanges(ts, "/workspace/example.vue", document, [
    { text: "new\nlines\n" },
    { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, text: "end" },
    { text: "final" },
  ]);
  assert.deepEqual(sent.map(({ command }) => command), ["change", "change", "change"]);
  assert.deepEqual(sent.map(({ args }) => [args.line, args.offset, args.endLine, args.endOffset]), [
    [1, 1, 2, 5], [3, 1, 3, 1], [1, 1, 3, 4],
  ]);
  assert.equal(document.text, "final");
});

test("Vue full replacements preserve tsserver line boundaries for every newline convention", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const sent = [];
    const document = { text: `first${newline}last${newline}` };
    applyDocumentChanges({ notify: (_command, args) => sent.push(args) }, "/example.vue", document, [{ text: "new" }]);
    assert.deepEqual([sent[0].endLine, sent[0].endOffset], [3, 1]);
    assert.equal(document.text, "new");
  }
});

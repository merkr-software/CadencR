import { fileURLToPath, pathToFileURL } from "node:url";

export const FALLBACK_METHODS = new Set([
  "textDocument/hover", "textDocument/completion", "textDocument/definition", "textDocument/references",
]);

const position = (value) => ({ line: value.line - 1, character: value.offset - 1 });
const range = (value) => ({ start: position(value.start), end: position(value.end) });
const text = (parts) => typeof parts === "string" ? parts : (parts ?? []).map((part) => part.text).join("");

/** LSP changes are sequential UTF-16 edits, matching tsserver's one-based coordinates. */
export function applyDocumentChanges(ts, file, document, changes) {
  for (const change of changes) {
    const lineStarts = [0];
    for (const newline of document.text.matchAll(/\r\n|\r|\n/g)) {
      lineStarts.push(newline.index + newline[0].length);
    }
    const start = change.range?.start ?? { line: 0, character: 0 };
    const end = change.range?.end ?? { line: lineStarts.length - 1, character: document.text.length - lineStarts.at(-1) };
    const offset = ({ line, character }) => lineStarts[line] + character;
    ts.notify("change", { file, line: start.line + 1, offset: start.character + 1,
      endLine: end.line + 1, endOffset: end.character + 1, insertString: change.text });
    document.text = document.text.slice(0, offset(start)) + change.text + document.text.slice(offset(end));
  }
}

export async function fallback(ts, request) {
  const params = request.params;
  const args = { file: fileURLToPath(params.textDocument.uri), line: params.position.line + 1,
    offset: params.position.character + 1 };
  try {
    if (request.method === "textDocument/hover") {
      const result = await ts.request("quickinfo", args);
      if (!result) return null;
      return { contents: { kind: "markdown", value: `\`\`\`typescript\n${result.displayString}\n\`\`\`\n${text(result.documentation)}` },
        range: range(result) };
    }
    if (request.method === "textDocument/completion") {
      const result = await ts.request("completionInfo", { ...args, includeExternalModuleExports: true,
        includeInsertTextCompletions: true });
      if (!result) return null;
      return { isIncomplete: false, items: result.entries.map((entry) => ({ label: entry.name,
        sortText: entry.sortText, insertText: entry.insertText ?? entry.name, detail: entry.kind })) };
    }
    if (request.method === "textDocument/definition") {
      const result = await ts.request("definition", args);
      return (result ?? []).map((entry) => ({ uri: pathToFileURL(entry.file).href, range: range(entry) }));
    }
    if (request.method === "textDocument/references") {
      const result = await ts.request("references", args);
      return (result?.refs ?? []).filter((entry) => params.context?.includeDeclaration || !entry.isDefinition)
        .map((entry) => ({ uri: pathToFileURL(entry.file).href, range: range(entry) }));
    }
  } catch (error) {
    if (/No content available|No Project|No project|Could not find source file/.test(error.message)) return null;
    throw error;
  }
  return null;
}

export function empty(value) {
  return value == null || (Array.isArray(value) && value.length === 0)
    || (Array.isArray(value.items) && value.items.length === 0);
}

// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { highlightTree, classHighlighter } from "@lezer/highlight";
import { describe, it, expect } from "vitest";
import { getLanguageExtension } from "../language-extensions";

describe("getLanguageExtension", () => {
  const supported = [
    "file.ts",
    "file.tsx",
    "file.js",
    "file.jsx",
    "file.json",
    "file.jsonc",
    "file.html",
    "file.htm",
    "file.css",
    "file.scss",
    "file.less",
    "file.svelte",
    "file.vue",
    "file.astro",
    "file.rs",
    "file.md",
    "file.yaml",
    "file.yml",
    "file.py",
    "file.go",
    "file.sql",
    "file.sh",
    "file.bash",
    "file.zsh",
    "file.toml",
    "Dockerfile",
    "services/api.Dockerfile",
    ".env",
    ".env.local",
    ".env.production.local",
    "local.env",
    "development.env",
    "API.ENV",
  ];

  for (const file of supported) {
    it(`returns a non-null extension for ${file}`, () => {
      expect(getLanguageExtension(file)).not.toBeNull();
    });
  }

  it("returns null for unknown extension", () => {
    expect(getLanguageExtension("file.xyz")).toBeNull();
    expect(getLanguageExtension("file.abc123")).toBeNull();
  });

  it("handles unsupported files with no extension", () => {
    expect(getLanguageExtension("Makefile")).toBeNull();
  });

  it("uses an explicit language instead of the file extension", () => {
    expect(getLanguageExtension("schema.data", "json")).not.toBeNull();
    expect(getLanguageExtension("script.ts", "plaintext")).toBeNull();
  });

  it("does not treat unrelated files as env", () => {
    // `env` (no extension) and `env.txt` shouldn't trigger env-file
    // detection — only filenames with `.env` as a real segment.
    expect(getLanguageExtension("env")).toBeNull();
    expect(getLanguageExtension("env.txt")).toBeNull();
  });
});

function highlightClassesFor(filePath: string, doc: string): string[] {
  const extension = getLanguageExtension(filePath);
  if (!extension) return [];
  const state = EditorState.create({ doc, extensions: [extension] });
  const tree = ensureSyntaxTree(state, doc.length, 1_000) ?? syntaxTree(state);
  const classes = new Set<string>();
  highlightTree(tree, classHighlighter, (_from, _to, classesForToken) => {
    for (const className of classesForToken.split(" ")) classes.add(className);
  });
  return [...classes];
}

describe("rich syntax highlighting", () => {
  it("highlights Astro frontmatter as TypeScript instead of YAML/plain text", () => {
    const extension = getLanguageExtension("file.astro");
    expect(extension).not.toBeNull();
    const view = new EditorView({
      doc: "---\nconst title = 'Hi';\n---\n<h1>{title}</h1>\n",
      extensions: [extension!],
    });

    expect(view.dom.querySelector(".cm-astro-keyword")?.textContent).toBe("const");
    expect(view.dom.querySelector(".cm-astro-string")?.textContent).toBe("'Hi'");
    expect(
      [...view.dom.querySelectorAll(".cm-astro-variable")].filter(
        (node) => node.textContent === "title",
      ),
    ).toHaveLength(2);
    expect(view.dom.querySelector(".cm-astro-frontmatter-delimiter")?.textContent).toContain("---");
    view.destroy();
  });

  it("highlights YAML keys", () => {
    expect(highlightClassesFor("file.yaml", "name: test\n")).toContain("tok-propertyName");
  });
});

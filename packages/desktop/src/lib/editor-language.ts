import { getFileExtension, isDockerfilePath, isEnvFilePath } from "@/lib/file-language";

export const EDITOR_LANGUAGES = [
  { id: "plaintext", label: "Plain Text" },
  { id: "typescript", label: "TypeScript" },
  { id: "typescriptreact", label: "TSX" },
  { id: "javascript", label: "JavaScript" },
  { id: "javascriptreact", label: "JSX" },
  { id: "json", label: "JSON" },
  { id: "jsonc", label: "JSONC" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "scss", label: "SCSS" },
  { id: "less", label: "LESS" },
  { id: "svelte", label: "Svelte" },
  { id: "vue", label: "Vue" },
  { id: "astro", label: "Astro" },
  { id: "rust", label: "Rust" },
  { id: "markdown", label: "Markdown" },
  { id: "mdx", label: "MDX" },
  { id: "yaml", label: "YAML" },
  { id: "toml", label: "TOML" },
  { id: "python", label: "Python" },
  { id: "go", label: "Go" },
  { id: "sql", label: "SQL" },
  { id: "shellscript", label: "Shell" },
  { id: "dockerfile", label: "Dockerfile" },
  { id: "env", label: "Env" },
] as const;

export type EditorLanguageId = (typeof EDITOR_LANGUAGES)[number]["id"];

const LANGUAGE_BY_ID = new Map(EDITOR_LANGUAGES.map((language) => [language.id, language]));

const EXTENSION_LANGUAGES: Readonly<Record<string, EditorLanguageId>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  json: "json",
  jsonc: "jsonc",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  svelte: "svelte",
  vue: "vue",
  astro: "astro",
  rs: "rust",
  md: "markdown",
  mdx: "mdx",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  py: "python",
  go: "go",
  sql: "sql",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
};

export function isEditorLanguageId(value: unknown): value is EditorLanguageId {
  return typeof value === "string" && LANGUAGE_BY_ID.has(value as EditorLanguageId);
}

export function detectEditorLanguageId(filePath: string): EditorLanguageId {
  if (isDockerfilePath(filePath)) return "dockerfile";
  if (isEnvFilePath(filePath)) return "env";
  const extension = getFileExtension(filePath);
  return Object.hasOwn(EXTENSION_LANGUAGES, extension)
    ? EXTENSION_LANGUAGES[extension]
    : "plaintext";
}

export function getEditorLanguageLabel(languageId: EditorLanguageId): string {
  return LANGUAGE_BY_ID.get(languageId)?.label ?? "Plain Text";
}

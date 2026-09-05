/**
 * Detects `path/to/file.ext`, `path/to/file.ext:LINE`, and
 * `path/to/file.ext:LINE:COL` patterns in prose text, and builds/parses the
 * `cadencr-file:` link href that carries them through markdown — the same
 * shape of module as `conversation-reference.ts`'s `cadencr-conversation:`
 * scheme, for the same reason: a custom URL scheme survives markdown link
 * parsing without inventing a second rendering path.
 */

// Extensions considered plausible file references. A missing extension here
// is a silent false negative (a real reference goes unlinked); an extension
// NOT gated behind this list risks a false positive (ordinary prose becomes
// a broken link) — the asymmetry is why this stays a list, not a heuristic.
const KNOWN_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "rs",
  "go",
  "py",
  "rb",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "hpp",
  "cpp",
  "cc",
  "cs",
  "php",
  "scala",
  "sh",
  "bash",
  "zsh",
  "fish",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "md",
  "mdx",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "sql",
  "graphql",
  "proto",
  "vue",
  "svelte",
  "txt",
  "xml",
  "ini",
  "cfg",
  "conf",
  "lock",
  "env",
  "dockerfile",
  "makefile",
]);

// Path: one or more filename segments (word chars, dots, dashes, slashes)
// ending in `.<extension>`, followed by an optional `:line` and `:col`. The
// extension itself is validated against KNOWN_EXTENSIONS after matching,
// since a regex character class can't express "known extension" directly.
const FILE_REFERENCE_PATTERN =
  /(?<![\w./-])((?:[\w-]+\/)*[\w-]+\.([A-Za-z][\w]{0,9}))(?::(\d+))?(?::(\d+))?(?![\w./-])/g;

export interface FileReferenceMatch {
  path: string;
  line?: number;
  col?: number;
  start: number;
  end: number;
}

export function parseFileReferences(text: string): FileReferenceMatch[] {
  const matches: FileReferenceMatch[] = [];
  for (const match of text.matchAll(FILE_REFERENCE_PATTERN)) {
    if (match.index == null) continue;
    const [full, path, extension, lineRaw, colRaw] = match;
    if (!KNOWN_EXTENSIONS.has(extension.toLowerCase())) continue;

    matches.push({
      path,
      line: lineRaw !== undefined ? Number(lineRaw) : undefined,
      col: colRaw !== undefined ? Number(colRaw) : undefined,
      start: match.index,
      end: match.index + full.length,
    });
  }
  return matches;
}

const FILE_HREF_SCHEME = "cadencr-file";

export function fileReferenceHref(path: string, line?: number, col?: number): string {
  const params = new URLSearchParams();
  if (line !== undefined) params.set("line", String(line));
  if (col !== undefined) params.set("col", String(col));
  const query = params.toString();
  return `${FILE_HREF_SCHEME}:${encodeURIComponent(path)}${query ? `?${query}` : ""}`;
}

export interface ParsedFileReferenceHref {
  path: string;
  line?: number;
  col?: number;
}

export function parseFileReferenceHref(href: string): ParsedFileReferenceHref | null {
  if (!href.startsWith(`${FILE_HREF_SCHEME}:`)) return null;
  const rest = href.slice(FILE_HREF_SCHEME.length + 1);
  const [encodedPath, query] = rest.split("?");
  if (!encodedPath) return null;

  let path: string;
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }

  const params = new URLSearchParams(query ?? "");
  const lineRaw = params.get("line");
  const colRaw = params.get("col");
  return {
    path,
    line: lineRaw !== null ? Number(lineRaw) : undefined,
    col: colRaw !== null ? Number(colRaw) : undefined,
  };
}

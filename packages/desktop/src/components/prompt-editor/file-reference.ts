import { fileUriToPath } from "@/lib/lsp/file-uri";

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

/** `scheme:` prefixes that are never file paths, even without `//`. */
const NON_FILE_SCHEME = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|tel:|data:|javascript:|cadencr-)/i;
/** `localhost:5173/x`: a web address the author forgot to prefix. */
const HOST_PORT = /^[\w.-]+:\d+\//;
/** `:line` or `:line:col` suffix (VS Code / compiler style). */
const COLON_POSITION = /^(.*?):(\d+)(?::(\d+))?$/;
/** GitHub-style `#L42`, `#L42C7`, `#L42-L50`. */
const HASH_POSITION = /^(.*?)#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/;

/**
 * The plain markdown file links agents write — `[foo.ts](src/foo.ts:42)`,
 * `[foo.ts](src/foo.ts#L42)`, `[x](/abs/x.rs)`, `[x](file:///abs/x.rs)` — so
 * clicking one opens the file like a `cadencr-file:` link does. Anything that
 * looks like a web or app URL is left to the regular link router.
 */
export function parseAgentFileHref(href: string): ParsedFileReferenceHref | null {
  const raw = href.trim();
  let decoded: string | null;
  if (raw.startsWith("file://")) {
    decoded = fileUriToPath(raw);
  } else if (NON_FILE_SCHEME.test(raw) || HOST_PORT.test(raw) || /^[#?]/.test(raw)) {
    return null;
  } else {
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  if (!decoded) return null;

  const position = HASH_POSITION.exec(decoded) ?? COLON_POSITION.exec(decoded);
  const path = position ? position[1] : decoded;
  if (!looksLikeFilePath(path)) return null;
  return {
    path,
    ...(position?.[2] ? { line: Number(position[2]) } : {}),
    ...(position?.[3] ? { col: Number(position[3]) } : {}),
  };
}

/**
 * A path, not prose or a domain: it has a directory separator, or a bare file
 * name with a known extension (so `example.com` or `v1.2` stay web links).
 */
function looksLikeFilePath(path: string): boolean {
  if (path.length === 0 || /[?#]/.test(path) || /^www\./i.test(path)) return false;
  if (path.includes("/")) return true;
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1];
  return extension !== undefined && KNOWN_EXTENSIONS.has(extension.toLowerCase());
}

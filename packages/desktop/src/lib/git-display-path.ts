/** Escapes git writes for the characters it quotes in a path (`core.quotePath`). */
const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  "\u0007": "\\a",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\v": "\\v",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};
const NAMED_UNESCAPES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(NAMED_ESCAPES).map(([char, escape]) => [escape.slice(1), char]),
);

/** C0 and C1 control characters, DEL, the quote and the backslash. */
function needsEscapeCode(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x22 || code === 0x5c;
}

const octal = (byte: number): string => `\\${byte.toString(8).padStart(3, "0")}`;

/** A `charCodeAt` scan: ordinary paths (nearly all of them) allocate nothing. */
function needsEscape(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    if (needsEscapeCode(path.charCodeAt(i))) return true;
  }
  return false;
}

/**
 * A C1 control (U+0080 to U+009F) is two UTF-8 bytes, 0xC2 then the code
 * point itself, written in octal as git does (`\302\205` for U+0085).
 */
function escapeChar(char: string): string {
  const code = char.charCodeAt(0);
  if (!needsEscapeCode(code)) return char;
  if (code >= 0x80) return octal(0xc2) + octal(code);
  return NAMED_ESCAPES[char] ?? octal(code);
}

const UTF8 = new TextDecoder();

/** A run of octal escapes is UTF-8 bytes: an ASCII control or a C1 control. */
function decodeOctalRun(run: string): string {
  const bytes = run
    .split("\\")
    .slice(1)
    .map((digits) => parseInt(digits, 8));
  return UTF8.decode(Uint8Array.from(bytes));
}

/**
 * A repository path as text that keeps every character visible. HTML folds a
 * newline or a tab in a name into a space, so a path holding a control
 * character (C0 or C1) is shown quoted and escaped the way git prints it
 * (`"a\nb.txt"`, `"a\302\205b.txt"`), along with any quote or backslash, so
 * the quoted form is never ambiguous.
 * Non-ASCII stays as it is. Display only: actions keep the raw path.
 */
export function displayGitPath(path: string): string {
  if (!needsEscape(path)) return path;
  return `"${path.replace(/[^]/g, escapeChar)}"`;
}

/**
 * The real path behind `displayGitPath`'s output. A real name holding a quote
 * is always displayed quoted, so a quoted text is always an escaped one.
 */
export function parseGitDisplayPath(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  return text
    .slice(1, -1)
    .replace(/((?:\\[0-7]{3})+)|\\([^])/g, (_escape: string, run?: string, body?: string) =>
      run ? decodeOctalRun(run) : (NAMED_UNESCAPES[body ?? ""] ?? body ?? ""),
    );
}

/**
 * A repository path as a file tree names it. A tree labels each row with its
 * path segment, so each segment is escaped on its own and folders stay folders
 * (`dir/"a\nb.txt"`). An ordinary path is returned as it is. Display only:
 * `parseGitTreePath` gives actions the real path back.
 */
export function displayGitTreePath(path: string): string {
  // A path that needs no escape is shown as it is: skip the per-segment work.
  if (!needsEscape(path)) return path;
  return path.split("/").map(displayGitPath).join("/");
}

/** The real path of a `displayGitTreePath` output, file or folder. */
export function parseGitTreePath(treePath: string): string {
  if (!treePath.includes('"')) return treePath;
  return treePath.split("/").map(parseGitDisplayPath).join("/");
}

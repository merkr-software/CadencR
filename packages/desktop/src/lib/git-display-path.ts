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

function needsEscapeCode(code: number): boolean {
  return code < 0x20 || code === 0x7f || code === 0x22 || code === 0x5c;
}

/** A `charCodeAt` scan: ordinary paths (nearly all of them) allocate nothing. */
function needsEscape(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    if (needsEscapeCode(path.charCodeAt(i))) return true;
  }
  return false;
}

function escapeChar(char: string): string {
  if (!needsEscapeCode(char.charCodeAt(0))) return char;
  return NAMED_ESCAPES[char] ?? `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`;
}

/**
 * A repository path as text that keeps every character visible. HTML folds a
 * newline or a tab in a name into a space, so a path holding a control
 * character is shown quoted and escaped the way git prints it (`"a\nb.txt"`),
 * along with any quote or backslash, so the quoted form is never ambiguous.
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
    .replace(/\\([0-7]{3}|[^])/g, (escape: string, body: string) =>
      body.length === 3 ? String.fromCharCode(parseInt(body, 8)) : (NAMED_UNESCAPES[body] ?? body),
    );
}

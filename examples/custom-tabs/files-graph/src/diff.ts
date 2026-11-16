export type DiffLineKind = "add" | "del" | "context" | "hunk" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number on the old side (`del`, `context`). */
  oldNumber: number | null;
  /** Line number on the new side (`add`, `context`). */
  newNumber: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** File headers git prints before the first hunk; the panel already names the file. */
const FILE_HEADER = /^(diff --git |index |--- |\+\+\+ |similarity index |dissimilarity index )/;

/**
 * Parses one file's unified diff (`git diff` output) into numbered lines.
 * File headers are dropped, except the ones that say something the hunks do
 * not (`new file mode`, `rename from`, `Binary files … differ`).
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text: raw, oldNumber: null, newNumber: null });
      continue;
    }
    if (!inHunk || raw.startsWith("diff --git ")) {
      inHunk = false;
      if (raw !== "" && !FILE_HEADER.test(raw)) {
        lines.push({ kind: "meta", text: raw, oldNumber: null, newNumber: null });
      }
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), oldNumber: null, newNumber: newLine++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldNumber: oldLine++, newNumber: null });
    } else if (raw.startsWith("\\")) {
      lines.push({ kind: "meta", text: raw, oldNumber: null, newNumber: null });
    } else if (raw.startsWith(" ")) {
      lines.push({
        kind: "context",
        text: raw.slice(1),
        oldNumber: oldLine++,
        newNumber: newLine++,
      });
    }
    // Anything else inside a hunk is the empty string after the final newline.
  }
  return lines;
}

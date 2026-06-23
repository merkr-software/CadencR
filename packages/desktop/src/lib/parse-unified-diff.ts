/**
 * Parse a unified diff string into per-file sections.
 * Each section contains the file names and the hunk lines (starting from @@).
 *
 * Shared between DiffViewer (multi-file git diffs) and InlineDiffBlock (single-file inline diffs).
 */
/** @public - used via import() type in DiffViewer.tsx */
export interface FileDiffSection {
  oldFileName: string;
  newFileName: string;
  hunks: string[];
}

export function hasTextHunks(section: FileDiffSection): boolean {
  return section.hunks.some((hunk) => hunk.includes("\n@@"));
}

export function parseUnifiedDiff(rawDiff: string): FileDiffSection[] {
  if (!rawDiff.trim()) return [];

  const sections: FileDiffSection[] = [];
  const lines = rawDiff.split("\n");
  let i = 0;

  while (i < lines.length) {
    // Find next "diff --git" header
    if (!lines[i].startsWith("diff --git ")) {
      i++;
      continue;
    }

    // Capture the full diff block for this file (headers + hunks) as a single string
    const blockStart = i;
    let oldFileName = "";
    let newFileName = "";
    const gitNames = lines[i].match(/^diff --git a\/(.*) b\/(.*)$/);
    if (gitNames) {
      oldFileName = gitNames[1];
      newFileName = gitNames[2];
    }
    i++;

    // Parse header lines until we hit a hunk or next diff
    while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git ")) {
      if (lines[i].startsWith("--- ")) {
        oldFileName = lines[i].slice(4).replace(/^a\//, "");
      } else if (lines[i].startsWith("+++ ")) {
        newFileName = lines[i].slice(4).replace(/^b\//, "");
      }
      i++;
    }

    // Collect all hunk lines for this file
    while (i < lines.length && !lines[i].startsWith("diff --git ")) {
      i++;
    }

    if (oldFileName || newFileName) {
      // DiffFile.createInstance expects hunks as an array with
      // the full diff text (headers + hunks) as a single string entry
      const fullBlock = lines.slice(blockStart, i).join("\n");
      sections.push({
        oldFileName: oldFileName || "/dev/null",
        newFileName: newFileName || "/dev/null",
        hunks: [fullBlock],
      });
    }
  }

  return sections;
}

/**
 * Per-file diff metadata: the parsed section plus its display name and line
 * stats. This is the shape the diff file list / tree renders from. Building it
 * walks every line of the diff (parse + stat), so for large diffs it runs in a
 * Web Worker — keep this function pure and free of DOM/React references so it
 * stays worker-safe. Shared between `useParsedDiff` (sync path) and
 * `diff-parse.worker.ts` (off-thread path).
 */
export interface ParsedFileMeta {
  section: FileDiffSection;
  displayName: string;
  additions: number;
  deletions: number;
}

export function buildParsedFileMeta(rawDiff: string): ParsedFileMeta[] {
  return parseUnifiedDiff(rawDiff).map((section) => {
    const displayName =
      section.newFileName !== "/dev/null" ? section.newFileName : section.oldFileName;
    const { additions, deletions } = countHunkStats(section.hunks);
    return { section, displayName, additions, deletions };
  });
}

/**
 * Count addition and deletion lines in raw hunk text.
 * Lines starting with '+' (but not '+++') are additions.
 * Lines starting with '-' (but not '---') are deletions.
 */
export function countHunkStats(hunks: string[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
  }
  return { additions, deletions };
}

/**
 * Infer a language identifier from a file path extension.
 * Used for syntax highlighting in diff views.
 */
export function langFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    css: "css",
    scss: "scss",
    html: "xml",
    xml: "xml",
    md: "markdown",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    sql: "sql",
    sh: "shell",
    bash: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    dockerfile: "dockerfile",
    makefile: "makefile",
  };
  return map[ext] ?? "plaintext";
}

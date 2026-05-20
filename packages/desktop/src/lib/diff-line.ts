export function firstChangedNewLine(patch: string): number | undefined {
  const lines = patch.split("\n");
  let newLine: number | null = null;

  for (const line of lines) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (newLine == null) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) return Math.max(1, newLine);
    if (line.startsWith("-")) return Math.max(1, newLine);
    if (line.startsWith(" ") || line === "") newLine += 1;
  }

  return undefined;
}

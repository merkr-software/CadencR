import type { AgentPathMapper } from "@/lib/git-paths";

/**
 * Formats diff comments into a markdown string grouped by file path,
 * suitable for sending to an agent. Comments are stored under the Git tab's
 * repository-relative paths; `toAgentPath` names each file the way the agent
 * resolves it from its working directory.
 */
export function formatCommentsForAgent(
  comments: ReadonlyArray<{ file_path: string; line_number: number; content: string }>,
  toAgentPath: AgentPathMapper,
): string {
  const grouped = new Map<string, { line_number: number; content: string }[]>();
  for (const c of comments) {
    const list = grouped.get(c.file_path) ?? [];
    list.push({ line_number: c.line_number, content: c.content });
    grouped.set(c.file_path, list);
  }
  const parts: string[] = [];
  for (const [filePath, items] of grouped) {
    parts.push(`## ${toAgentPath(filePath)}`);
    for (const item of items) {
      parts.push(`- Line ${item.line_number}: ${item.content}`);
    }
  }
  return parts.join("\n");
}

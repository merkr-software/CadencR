import { parseMcpTool } from "@/lib/mcp-tool-parser";
import { isFileChangeTool, normalizeToolName } from "@/lib/tool-adapter";
import { getToolActivityLabel } from "@/lib/tool-call-parser";
import type { NotchActionKind } from "@/shared/notch";

/**
 * One-line, glanceable summary of an agent's latest tool call for the notch
 * island ("Running command: pnpm test", "Editing …/notch/NotchIsland.tsx").
 * Reuses the stream's own tool parsers so every provider's tools read the same
 * here as in the transcript; only the icon family is decided locally.
 */

const KIND_BY_TOOL: Record<string, NotchActionKind> = {
  Bash: "bash",
  exec_command: "bash",
  write_stdin: "bash",
  Read: "read",
  LS: "read",
  Glob: "search",
  Grep: "search",
  Search: "search",
  ToolSearch: "search",
  WebSearch: "web",
  WebFetch: "web",
  Fetch: "web",
  Task: "agent",
  Agent: "agent",
};

const MAX_LABEL_CHARS = 160;
/** Absolute paths eat the whole line; keep the last two segments. */
const LONG_PATH = /(?:\/[^\s/:'"`]+){3,}\/?/g;

export function notchActionKind(toolName: string, toolArgs?: string): NotchActionKind {
  const canonical = normalizeToolName(toolName);
  if (parseMcpTool(canonical, toolArgs)) return "mcp";
  if (isFileChangeTool(canonical)) return "edit";
  return KIND_BY_TOOL[canonical] ?? "tool";
}

export function shortenPaths(text: string): string {
  return text.replace(LONG_PATH, (match) => {
    const segments = match.split("/").filter(Boolean);
    return `…/${segments.slice(-2).join("/")}`;
  });
}

export function notchActionLabel(toolName: string, toolArgs?: string): string {
  const oneLine = getToolActivityLabel(toolName, toolArgs).replace(/\s+/g, " ").trim();
  const short = shortenPaths(oneLine);
  return short.length > MAX_LABEL_CHARS ? `${short.slice(0, MAX_LABEL_CHARS - 1)}…` : short;
}

/**
 * Agent replies are markdown; the island shows two plain lines of them. Drop
 * the syntax that reads as noise out of context (headings, emphasis, code
 * fences, table pipes, link targets) and keep the words.
 */
export function plainPreview(markdown: string): string {
  return markdown
    .replace(/```[a-z0-9_-]*/gi, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\|\s*-{3,}[\s|:-]*/g, " ")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/(^|\s)[-*]\s+/g, "$1")
    .replace(/(?:\s·)+\s*$/g, "")
    .replace(/^\s*·\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

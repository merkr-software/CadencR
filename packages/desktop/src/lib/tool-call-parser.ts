import { extractApplyPatchPrimaryPath } from "@/lib/apply-patch";
import { parseToolArgsObject, stringArg } from "@/lib/tool-args";
import { extractBashCommandFromArgs, normalizeToolName } from "@/lib/tool-adapter";

/**
 * Parses Claude Code tool call arguments into human-readable summaries.
 * Used to show what the agent is doing (e.g. "Reading src/main.ts").
 *
 * Add new tool parsers by extending the `toolParsers` map.
 */

interface ToolSummary {
  /** Short label like "Running subtask" */
  label: string;
  /** Detail string like "Find agent output parsing files" */
  detail?: string;
}

/** Parsed Cadencr MCP tool name */
export interface CadencrMcpTool {
  /** Server name without prefix, currently "browser" */
  server: string;
  /** Raw tool name, e.g. "browser_open_url" */
  tool: string;
  /** Human-readable label, e.g. "Opening URL" */
  label: string;
  /** Detail extracted from args */
  detail?: string;
}

const CADENCR_MCP_HYPHEN_PREFIX = "mcp__cadencr-";
const CADENCR_MCP_NAMESPACE_PREFIX = "mcp__cadencr_";

/** Human-readable labels for known Cadencr MCP tools. Falls back to title-casing the tool name. */
const cadencrToolLabels: Record<string, string> = {
  browser_click: "Clicking browser",
  browser_get_console: "Reading console",
  browser_get_network: "Reading network",
  browser_get_snapshot: "Capturing snapshot",
  browser_keypress: "Pressing key",
  browser_list_tabs: "Listing browser tabs",
  browser_open_url: "Opening URL",
  browser_select_element_context: "Selecting element context",
  browser_screenshot: "Taking screenshot",
  browser_type: "Typing in browser",
  project_compare_sessions: "Comparing sessions",
  project_find_related_sessions: "Finding related sessions",
  project_get_session_status: "Checking session status",
  project_get_worktree_status: "Checking worktree status",
  project_link_sessions: "Linking sessions",
  project_list_sessions: "Listing project sessions",
  project_read_session: "Reading project session",
  project_read_session_tail: "Reading session tail",
  project_send_session_message: "Sending session message",
  project_spawn_session: "Spawning session",
  workspace_list_projects: "Listing workspace projects",
  workspace_read_session: "Reading workspace session",
  workspace_read_sessions: "Searching workspace sessions",
  workspace_recent_activity: "Reading recent activity",
  workspace_session_graph: "Reading session graph",
};

/**
 * Read a string arg, rejecting empty strings.
 *
 * OpenAI strict JSON schemas fill optional string fields with `""` when the
 * model doesn't provide them, so a naive `typeof === "string"` check would
 * short-circuit on that sentinel and prevent fall-back to the next field.
 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Extract a meaningful detail string from Cadencr MCP tool args. */
function cadencrDetail(tool: string, args: Record<string, unknown>): string | undefined {
  const title = nonEmptyString(args.title);
  if (title) return title;
  const summary = nonEmptyString(args.summary);
  if (summary) return summary;
  const commitMessage = nonEmptyString(args.commit_message);
  if (commitMessage) return commitMessage;
  const prompt = nonEmptyString(args.prompt);
  if (prompt) return prompt.slice(0, 80);
  const query = nonEmptyString(args.query);
  if (query) return query.slice(0, 80);
  const message = nonEmptyString(args.message);
  if (message) return message.slice(0, 80);
  const url = nonEmptyString(args.url);
  if (url) return url;
  const tabId = nonEmptyString(args.tab_id);
  if (tabId) return `Tab ${tabId}`;
  const key = nonEmptyString(args.key);
  if (key) return key;
  return undefined;
}

/** Title-case a snake_case tool name as fallback label. */
function snakeToLabel(name: string): string {
  return name
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Try to parse a tool name as a Cadencr MCP tool.
 *
 * Supported names:
 * - canonical Cadencr app server: mcp__cadencr-<server>__<tool>
 * - Codex raw MCP namespace form: mcp__cadencr_<server>____<tool>
 */
export function parseCadencrMcpTool(
  toolName: string,
  toolArgs?: string,
): CadencrMcpTool | undefined {
  const parsed = parseCadencrMcpToolName(toolName);
  if (!parsed) return undefined;

  const args = parseToolArgsObject(toolArgs) ?? {};

  return {
    server: parsed.server,
    tool: parsed.tool,
    label: cadencrToolLabels[parsed.tool] ?? snakeToLabel(parsed.tool),
    detail: cadencrDetail(parsed.tool, args),
  };
}

export function isCadencrPlanPresentationTool(_toolName: string | undefined): boolean {
  return false;
}

function parseCadencrMcpToolName(toolName: string): { server: string; tool: string } | undefined {
  if (toolName.startsWith(CADENCR_MCP_HYPHEN_PREFIX)) {
    return parseMcpNameRest(toolName.slice(CADENCR_MCP_HYPHEN_PREFIX.length), "__");
  }

  if (!toolName.startsWith(CADENCR_MCP_NAMESPACE_PREFIX)) return undefined;
  return parseMcpNameRest(toolName.slice(CADENCR_MCP_NAMESPACE_PREFIX.length), "____");
}

function parseMcpNameRest(
  rest: string,
  preferredSeparator: string,
): { server: string; tool: string } | undefined {
  const sep = rest.indexOf(preferredSeparator);
  if (sep !== -1) return parsedMcpParts(rest, sep, preferredSeparator.length);
  if (preferredSeparator !== "__") return parseMcpNameRest(rest, "__");
  return undefined;
}

function parsedMcpParts(
  rest: string,
  sep: number,
  separatorLength: number,
): { server: string; tool: string } | undefined {
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + separatorLength);
  if (!server || !tool) return undefined;
  if (!isCadencrMcpServer(server)) return undefined;
  return { server, tool };
}

function isCadencrMcpServer(server: string): boolean {
  return server === "browser" || server === "project" || server === "workspace";
}

type ToolParser = (args: Record<string, unknown>) => ToolSummary;

const toolParsers: Record<string, ToolParser> = {
  Task: (args) => ({
    label: "Running subtask",
    detail: stringArg(args, "description"),
  }),

  Agent: (args) => ({
    label: "Running subtask",
    detail: stringArg(args, "description"),
  }),

  Bash: (args) => ({
    label: "Running command",
    detail: extractBashCommandFromArgs(args),
  }),

  exec_command: (args) => ({
    label: "Starting terminal command",
    detail: extractBashCommandFromArgs(args),
  }),

  write_stdin: (args) => ({
    label: "Writing to terminal",
    detail: writeStdinDetail(args),
  }),

  Glob: (args) => {
    const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
    const path = typeof args.path === "string" ? args.path : undefined;
    const parts = [pattern, path].filter(Boolean);
    return {
      label: "Finding files",
      detail: parts.length > 0 ? parts.join(" in ") : undefined,
    };
  },

  Grep: (args) => {
    const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
    const type = typeof args.type === "string" ? args.type : undefined;
    const path = typeof args.path === "string" ? args.path : undefined;
    const parts: string[] = [];
    if (pattern) parts.push(pattern);
    if (type) parts.push(`(${type})`);
    if (path) parts.push(`in ${path}`);
    return {
      label: "Searching code",
      detail: parts.length > 0 ? parts.join(" ") : undefined,
    };
  },

  Read: (args) => ({
    label: "Reading file",
    detail: stringArg(args, "file_path", "filePath", "path"),
  }),

  LS: (args) => ({
    label: "Listing files",
    detail: stringArg(args, "path", "directory", "dir"),
  }),

  Write: (args) => ({
    label: "Writing file",
    detail: stringArg(args, "file_path", "filePath", "path"),
  }),

  Edit: (args) => ({
    label: "Editing file",
    detail: stringArg(args, "file_path", "filePath", "path"),
  }),

  ApplyPatch: (args) => ({
    label: "Applying patch",
    detail: extractApplyPatchPrimaryPath(args),
  }),

  WebSearch: (args) => ({
    label: "Searching web",
    detail: stringArg(args, "query"),
  }),

  WebFetch: (args) => ({
    label: "Fetching page",
    detail: stringArg(args, "url"),
  }),

  Skill: (args) => ({
    label: "Running skill",
    detail: stringArg(args, "skill", "name"),
  }),

  ToolSearch: (args) => ({
    label: "Searching tools",
    detail: stringArg(args, "query"),
  }),

  ExitPlanMode: () => ({
    label: "Plan ready for review",
  }),
};

function writeStdinDetail(args: Record<string, unknown>): string | undefined {
  const sessionId = sessionIdDetail(args);
  const chars = typeof args.chars === "string" ? args.chars : undefined;
  const suffix = sessionId ? ` ${sessionId}` : "";

  if (chars === undefined || chars.length === 0) return `poll session${suffix}`.trim();
  if (chars === "\u0003") return `interrupt session${suffix}`.trim();
  if (chars === "\u0004") return `send EOF to session${suffix}`.trim();
  return `send ${chars.length.toLocaleString()} chars to session${suffix}`.trim();
}

function sessionIdDetail(args: Record<string, unknown>): string | undefined {
  const value = args.session_id ?? args.sessionId ?? args.processId;
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/**
 * Parse a tool call into a human-readable summary.
 * Returns undefined if the tool is not recognized.
 */
export function parseToolCall(toolName: string, toolArgs?: string): ToolSummary | undefined {
  const parser = toolParsers[normalizeToolName(toolName)];
  if (!parser) return undefined;

  const args = parseToolArgsObject(toolArgs) ?? {};

  return parser(args);
}

/**
 * Get an activity label for the streaming indicator.
 * Returns something like "Reading src/main.ts" or "Running command: git status".
 */
export function getToolActivityLabel(toolName: string, toolArgs?: string): string {
  const canonicalToolName = normalizeToolName(toolName);
  const cadencr = parseCadencrMcpTool(canonicalToolName, toolArgs);
  if (cadencr) {
    const prefix = `[${cadencr.server}]`;
    return cadencr.detail
      ? `${prefix} ${cadencr.label}: ${cadencr.detail}`
      : `${prefix} ${cadencr.label}`;
  }
  const summary = parseToolCall(canonicalToolName, toolArgs);
  if (!summary) return `Running ${canonicalToolName}`;
  if (summary.detail) return `${summary.label}: ${summary.detail}`;
  return summary.label;
}

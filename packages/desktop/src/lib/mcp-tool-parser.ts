import { parseToolArgsObject } from "@/lib/tool-args";

export interface McpTool {
  server: string;
  tool: string;
  label: string;
  detail?: string;
  arguments: Record<string, unknown>;
}

interface McpIdentity {
  server: string;
  tool: string;
}

const MCP_PREFIX = "mcp__";
const HISTORICAL_SERVER_ALIASES: Record<string, string> = {
  cadencr_browser: "cadencr-browser",
  cadencr_project: "cadencr-project",
  cadencr_workspace: "cadencr-workspace",
  chrome_devtools: "chrome-devtools",
};

// Production OpenCode history predating adapter-side canonicalization stores
// MCP calls as `<server>_<tool>`. Bare names are ambiguous, so only resolve
// servers observed in that history; new calls are canonicalized before persist.
const HISTORICAL_BARE_SERVERS = ["chrome-devtools", "codegraph"] as const;

const FRIENDLY_LABELS: Record<string, string> = {
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
  click: "Clicking",
  evaluate_script: "Evaluating script",
  fetch_openai_doc: "Fetching documentation",
  fill: "Filling field",
  list_console_messages: "Reading console",
  list_pages: "Listing pages",
  navigate_page: "Navigating page",
  new_page: "Opening page",
  project_archive_session: "Archiving a session",
  project_compare_sessions: "Comparing sessions",
  project_create_schedule: "Scheduling a prompt",
  project_delete_schedule: "Deleting a schedule",
  project_find_related_sessions: "Finding related sessions",
  project_get_session_status: "Checking session status",
  project_get_settings: "Reading settings",
  project_get_worktree_status: "Checking worktree status",
  project_link_sessions: "Linking sessions",
  project_list_schedules: "Listing schedules",
  project_list_sessions: "Listing project sessions",
  project_read_session: "Reading project session",
  project_read_session_tail: "Reading session tail",
  project_send_session_message: "Sending session message",
  project_spawn_session: "Spawning session",
  project_update_schedule: "Updating a schedule",
  project_update_settings: "Changing settings",
  search_commits: "Searching commits",
  search_openai_docs: "Searching documentation",
  take_screenshot: "Taking screenshot",
  take_snapshot: "Taking snapshot",
  wait_for: "Waiting for page",
  workspace_get_settings: "Reading settings",
  workspace_list_projects: "Listing workspace projects",
  workspace_read_session: "Reading workspace session",
  workspace_read_sessions: "Searching workspace sessions",
  workspace_recent_activity: "Reading recent activity",
  workspace_session_graph: "Reading session graph",
  workspace_update_settings: "Changing settings",
};

export function parseMcpTool(toolName: string, toolArgs?: string): McpTool | undefined {
  const namedIdentity = identityFromName(toolName);
  if (!namedIdentity) return undefined;

  const rawArgs = parseToolArgsObject(toolArgs) ?? {};
  const explicit = explicitIdentity(rawArgs);
  const identity = explicit ?? namedIdentity;

  const normalized = normalizeAppIdentity(identity, rawArgs);
  const args = explicit ? nestedArguments(rawArgs) : rawArgs;
  const displayServer = normalized.server.startsWith("cadencr-")
    ? normalized.server.slice("cadencr-".length)
    : normalized.server;
  return {
    server: displayServer,
    tool: normalized.tool,
    label: FRIENDLY_LABELS[normalized.tool] ?? titleCaseTool(normalized.tool),
    detail: mcpDetail(args),
    arguments: args,
  };
}

/** Stable semantic identity for grouping MCP calls without parsing their arguments. */
export function mcpToolKey(toolName: string): string | undefined {
  const identity = identityFromName(toolName);
  if (!identity) return undefined;
  const normalized = normalizeAppIdentity(identity, {});
  return `${normalized.server}:${normalized.tool}`;
}

function explicitIdentity(args: Record<string, unknown>): McpIdentity | undefined {
  const server = nonEmptyString(args.server);
  const tool = nonEmptyString(args.tool);
  return server && tool ? { server, tool } : undefined;
}

function identityFromName(name: string): McpIdentity | undefined {
  if (name.startsWith(MCP_PREFIX)) return prefixedIdentity(name.slice(MCP_PREFIX.length));
  return bareIdentity(name);
}

function prefixedIdentity(rest: string): McpIdentity | undefined {
  const separator = rest.indexOf("__");
  if (separator < 1) return undefined;
  const rawServer = rest.slice(0, separator);
  const tool = rest.slice(separator + 2).replace(/^_+/, "");
  if (!tool) return undefined;
  return { server: HISTORICAL_SERVER_ALIASES[rawServer] ?? rawServer, tool };
}

function bareIdentity(name: string): McpIdentity | undefined {
  const server = HISTORICAL_BARE_SERVERS.find((candidate) => name.startsWith(`${candidate}_`));
  if (!server) return undefined;
  const tool = name.slice(server.length + 1);
  return tool ? { server, tool } : undefined;
}

function normalizeAppIdentity(identity: McpIdentity, args: Record<string, unknown>): McpIdentity {
  if (identity.server !== "codex_apps") return identity;
  const appContext = recordValue(args.appContext);
  const contextApp = nonEmptyString(appContext?.appName)?.toLowerCase();
  const contextAction = nonEmptyString(appContext?.actionName);
  if (contextApp && contextAction) return { server: contextApp, tool: contextAction };

  const separator = identity.tool.includes(".") ? "." : identity.tool.includes("___") ? "___" : "_";
  const index = identity.tool.indexOf(separator);
  if (index < 1) return identity;
  return {
    server: identity.tool.slice(0, index),
    tool: identity.tool.slice(index + separator.length),
  };
}

function nestedArguments(args: Record<string, unknown>): Record<string, unknown> {
  return recordValue(args.arguments) ?? args;
}

function mcpDetail(args: Record<string, unknown>): string | undefined {
  const tabId = nonEmptyString(args.tab_id);
  if (tabId) return `Tab ${tabId}`;
  for (const key of [
    "title",
    "summary",
    "commit_message",
    "repository_full_name",
    "repo_full_name",
    "query",
    "url",
    "filePath",
    "file_path",
    "key",
  ]) {
    const value = nonEmptyString(args[key]);
    if (value) return value.slice(0, 120);
  }
  for (const key of ["prompt", "message"]) {
    const value = nonEmptyString(args[key]);
    if (value) return value.slice(0, 80);
  }
  return undefined;
}

function titleCaseTool(name: string): string {
  return name
    .replace(/[.-]/g, "_")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

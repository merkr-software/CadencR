import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
import { extractApplyPatchPrimaryPath } from "@/lib/apply-patch";
import { parseToolArgsObject, stringArg } from "@/lib/tool-args";
import { extractBashCommandFromArgs, normalizeToolName } from "@/lib/tool-adapter";
import { parseMcpTool } from "@/lib/mcp-tool-parser";

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

export function isCadencrPlanPresentationTool(_toolName: string | undefined): boolean {
  return false;
}

type ToolParser = (args: Record<string, unknown>, t: UiTranslator) => ToolSummary;

const toolParsers: Record<string, ToolParser> = {
  Task: (args, t) => ({
    label: t("tools.activity.runningSubtask", "Running subtask"),
    detail: descriptionDetail(args) ?? stringArg(args, "prompt"),
  }),

  Agent: (args, t) => ({
    label: t("tools.activity.runningSubtask", "Running subtask"),
    detail: descriptionDetail(args) ?? stringArg(args, "prompt"),
  }),

  Bash: (args, t) => ({
    label: t("tools.activity.runningCommand", "Running command"),
    detail: extractBashCommandFromArgs(args) ?? descriptionDetail(args),
  }),

  exec_command: (args, t) => ({
    label: t("tools.activity.startingTerminalCommand", "Starting terminal command"),
    detail: extractBashCommandFromArgs(args),
  }),

  write_stdin: (args, t) => ({
    label: t("tools.activity.writingToTerminal", "Writing to terminal"),
    detail: writeStdinDetail(args, t),
  }),

  Glob: (args, t) => ({
    label: t("tools.activity.findingFiles", "Finding files"),
    detail: globDetail(args, t),
  }),

  Grep: (args, t) => ({
    label: t("tools.activity.searchingCode", "Searching code"),
    detail: searchDetail(args, t),
  }),

  Search: (args, t) => ({
    label: t("tools.activity.searchingCode", "Searching code"),
    detail: searchDetail(args, t),
  }),

  Read: (args, t) => ({
    label: t("tools.activity.readingFile", "Reading file"),
    detail: fileDetail(args),
  }),

  LS: (args, t) => ({
    label: t("tools.activity.listingFiles", "Listing files"),
    detail: stringArg(args, "path", "directory", "dir") ?? descriptionDetail(args),
  }),

  Write: (args, t) => ({
    label: t("tools.activity.writingFile", "Writing file"),
    detail: fileDetail(args),
  }),

  Edit: (args, t) => ({
    label: t("tools.activity.editingFile", "Editing file"),
    detail: fileDetail(args),
  }),

  ApplyPatch: (args, t) => ({
    label: t("tools.activity.applyingPatch", "Applying patch"),
    detail: extractApplyPatchPrimaryPath(args) ?? descriptionDetail(args),
  }),

  Delete: (args, t) => ({
    label: t("tools.activity.deletingFile", "Deleting file"),
    detail: fileDetail(args),
  }),

  Move: (args, t) => ({
    label: t("tools.activity.movingFile", "Moving file"),
    detail: moveDetail(args),
  }),

  Think: (args, t) => ({
    label: t("tools.activity.thinking", "Thinking"),
    detail: descriptionDetail(args),
  }),

  Fetch: (args, t) => ({
    label: t("tools.activity.fetchingResource", "Fetching resource"),
    detail: stringArg(args, "url", "uri") ?? fileDetail(args),
  }),

  SwitchMode: (args, t) => ({
    label: t("tools.activity.switchingMode", "Switching mode"),
    detail: stringArg(args, "targetModeId", "target_mode_id", "mode") ?? descriptionDetail(args),
  }),

  WebSearch: (args, t) => ({
    label: t("tools.activity.searchingWeb", "Searching web"),
    detail: stringArg(args, "query") ?? descriptionDetail(args),
  }),

  WebFetch: (args, t) => ({
    label: t("tools.activity.fetchingPage", "Fetching page"),
    detail: stringArg(args, "url") ?? descriptionDetail(args),
  }),

  GenerateImage: (args, t) => ({
    label: t("tools.activity.generatingImage", "Generating image"),
    detail: stringArg(args, "filePath", "file_path") ?? descriptionDetail(args),
  }),

  Skill: (args, t) => ({
    label: t("tools.activity.runningSkill", "Running skill"),
    detail: stringArg(args, "skill", "name"),
  }),

  ToolSearch: (args, t) => ({
    label: t("tools.activity.searchingTools", "Searching tools"),
    detail: stringArg(args, "query"),
  }),

  ExitPlanMode: (_args, t) => ({
    label: t("tools.activity.planReadyForReview", "Plan ready for review"),
  }),
};

function descriptionDetail(args: Record<string, unknown>): string | undefined {
  return stringArg(args, "description", "title", "summary");
}

function fileDetail(args: Record<string, unknown>): string | undefined {
  return stringArg(args, "file_path", "filePath", "path") ?? descriptionDetail(args);
}

function globDetail(args: Record<string, unknown>, t: UiTranslator): string | undefined {
  const pattern = stringArg(args, "pattern", "glob", "query") ?? descriptionDetail(args);
  const path = stringArg(args, "path", "directory", "dir");
  if (pattern && path && pattern !== path)
    return t("tools.activity.patternInPath", "{{pattern}} in {{path}}", { pattern, path });
  return pattern ?? path;
}

function searchDetail(args: Record<string, unknown>, t: UiTranslator): string | undefined {
  const query =
    stringArg(args, "pattern", "query", "searchTerm", "search_term") ?? descriptionDetail(args);
  const type = stringArg(args, "type");
  const path = stringArg(args, "path", "directory", "dir");
  const parts: string[] = [];
  if (query) parts.push(query);
  if (type) parts.push(`(${type})`);
  if (path && path !== query) parts.push(t("tools.activity.inPath", "in {{path}}", { path }));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function moveDetail(args: Record<string, unknown>): string | undefined {
  const source = stringArg(args, "source", "from", "oldPath", "old_path");
  const destination = stringArg(args, "destination", "to", "newPath", "new_path");
  if (source && destination) return `${source} → ${destination}`;
  return source ?? destination ?? fileDetail(args);
}

function writeStdinDetail(args: Record<string, unknown>, t: UiTranslator): string {
  const session = sessionIdDetail(args) ?? "";
  const chars = typeof args.chars === "string" ? args.chars : undefined;
  if (!chars)
    return t("tools.activity.pollSession", "poll session {{session}}", { session }).trim();
  if (chars === "\u0003")
    return t("tools.activity.interruptSession", "interrupt session {{session}}", {
      session,
    }).trim();
  if (chars === "\u0004")
    return t("tools.activity.sendEofToSession", "send EOF to session {{session}}", {
      session,
    }).trim();
  return t(
    "tools.activity.sendCharsToSession",
    "send {{count, number}} chars to session {{session}}",
    {
      count: chars.length,
      session,
    },
  ).trim();
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
export function parseToolCall(
  toolName: string,
  toolArgs?: string,
  t: UiTranslator = translateUi,
): ToolSummary | undefined {
  const canonicalToolName = normalizeToolName(toolName);
  const args = parseToolArgsObject(toolArgs) ?? {};
  const parser = toolParsers[canonicalToolName];
  if (!parser) {
    const detail = genericDetail(args);
    return detail
      ? {
          label: t("tools.activity.runningTool", "Running {{tool}}", { tool: canonicalToolName }),
          detail,
        }
      : undefined;
  }

  return parser(args, t);
}

function genericDetail(args: Record<string, unknown>): string | undefined {
  return (
    descriptionDetail(args) ??
    stringArg(args, "file_path", "filePath", "path", "url", "uri", "query", "pattern")
  );
}

/**
 * Get an activity label for the streaming indicator.
 * Returns something like "Reading src/main.ts" or "Running command: git status".
 */
export function getToolActivityLabel(
  toolName: string,
  toolArgs?: string,
  t: UiTranslator = translateUi,
): string {
  const canonicalToolName = normalizeToolName(toolName);
  const mcp = parseMcpTool(canonicalToolName, toolArgs, t);
  if (mcp) {
    const { server, label, detail } = mcp;
    return detail
      ? t("tools.activity.mcpWithDetail", "[{{server}}] {{label}}: {{detail}}", {
          server,
          label,
          detail,
        })
      : t("tools.activity.mcp", "[{{server}}] {{label}}", { server, label });
  }
  const summary = parseToolCall(canonicalToolName, toolArgs, t);
  if (!summary)
    return t("tools.activity.runningTool", "Running {{tool}}", { tool: canonicalToolName });
  if (summary.detail)
    return t("tools.activity.withDetail", "{{label}}: {{detail}}", {
      label: summary.label,
      detail: summary.detail,
    });
  return summary.label;
}

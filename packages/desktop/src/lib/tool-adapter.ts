import {
  extractApplyPatchPreviewPartial,
  extractApplyPatchPreviewsPartial,
  isApplyPatchToolName,
} from "@/lib/apply-patch";
import { parseToolArgsObject, stringArg } from "@/lib/tool-args";

export interface InlineDiffPreview {
  filePath: string;
  oldContent: string;
  newContent: string;
}

const FILE_CHANGE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "ApplyPatch"]);
const TASK_TODO_TOOLS = new Set(["TaskCreate", "TaskUpdate"]);
const LEGACY_OPENCODE_OUTPUT_KEYS = ["__opencode_output", "__opencode_stdout"] as const;
const LEGACY_OPENCODE_STATUS_KEY = "__opencode_status";

export function normalizeToolName(toolName: string): string {
  if (isApplyPatchToolName(toolName)) return "ApplyPatch";
  return toolName;
}

export function isFileChangeTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return FILE_CHANGE_TOOLS.has(normalizeToolName(toolName));
}

export function isTaskTodoTool(toolName: string | undefined): boolean {
  return toolName != null && TASK_TODO_TOOLS.has(toolName);
}

export function extractBashOutput(toolArgs?: string): string | undefined {
  const args = parseToolArgsObject(toolArgs);
  if (!args) return undefined;
  if (typeof args.aggregatedOutput === "string") return args.aggregatedOutput;
  const output = args.output;
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const structured = output as Record<string, unknown>;
    if (typeof structured.stdout === "string") return structured.stdout;
    if (typeof structured.output === "string") return structured.output;
  }
  for (const key of LEGACY_OPENCODE_OUTPUT_KEYS) {
    const legacyOutput = args[key];
    if (typeof legacyOutput === "string") return legacyOutput;
  }
  return undefined;
}

export function extractBashResultOutput(content: string): string | undefined {
  return extractBashOutput(content) ?? (isStructuredBashPayload(content) ? undefined : content);
}

export function extractBashCommand(toolArgs?: string): string | undefined {
  const args = parseToolArgsObject(toolArgs);
  if (!args) return undefined;
  return extractBashCommandFromArgs(args);
}

export function extractBashCommandFromArgs(args: Record<string, unknown>): string | undefined {
  return commandValue(args.command) ?? commandValue(args.cmd);
}

export function isStructuredBashPayload(toolArgs?: string): boolean {
  const args = parseToolArgsObject(toolArgs);
  if (!args) return false;
  return (
    "command" in args ||
    "cwd" in args ||
    "exitCode" in args ||
    "status" in args ||
    "output" in args ||
    "commandActions" in args ||
    "command_actions" in args ||
    LEGACY_OPENCODE_OUTPUT_KEYS.some((key) => key in args) ||
    LEGACY_OPENCODE_STATUS_KEY in args
  );
}

function commandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === "string");
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return stringArg(record, "command", "cmd", "description");
  }
  return undefined;
}

export function extractTaskOutput(toolArgs?: string): string | undefined {
  const args = parseToolArgsObject(toolArgs);
  if (!args) return undefined;

  const output = args.output;
  const text =
    typeof output === "string"
      ? output
      : output && typeof output === "object"
        ? extractStructuredTaskOutput(output as Record<string, unknown>)
        : undefined;

  if (!text) return undefined;

  const tagged = extractTaggedOutput(text, "task_result");
  const trimmed = (tagged ?? text).trim();
  return trimmed || undefined;
}

export function extractToolStatus(toolArgs?: string): string | undefined {
  const args = parseToolArgsObject(toolArgs);
  if (!args) return undefined;
  const status = args.status ?? args[LEGACY_OPENCODE_STATUS_KEY];
  return typeof status === "string" ? status.toLowerCase() : undefined;
}

function extractStructuredTaskOutput(output: Record<string, unknown>): string | undefined {
  if (typeof output.output === "string") return output.output;
  if (typeof output.stdout === "string") return output.stdout;
  if (typeof output.text === "string") return output.text;
  return undefined;
}

function extractTaggedOutput(text: string, tag: string): string | undefined {
  const startTag = `<${tag}>`;
  const endTag = `</${tag}>`;
  const start = text.indexOf(startTag);
  if (start === -1) return undefined;
  const end = text.indexOf(endTag, start + startTag.length);
  if (end === -1) return undefined;
  return text.slice(start + startTag.length, end);
}

export function isToolCallRunning(toolArgs?: string): boolean {
  const status = extractToolStatus(toolArgs);
  if (!status) return true;
  return status === "pending" || status === "running" || status === "active";
}

export function extractInlineDiffPreview(
  toolName: string,
  toolArgs?: string,
): InlineDiffPreview | null {
  if (isApplyPatchToolName(toolName)) {
    return toolArgs ? extractApplyPatchPreviewPartial(toolArgs) : null;
  }
  return extractInlineDiffPreviews(toolName, toolArgs)[0] ?? null;
}

export function extractInlineDiffPreviews(
  toolName: string,
  toolArgs?: string,
): InlineDiffPreview[] {
  if (isApplyPatchToolName(toolName)) {
    // The tolerant extractor already does a fast `JSON.parse` first and falls
    // back to a streaming-friendly scanner — calling `parseToolArgsObject`
    // here would just parse the same bytes a second time on every render.
    return toolArgs ? extractApplyPatchPreviewsPartial(toolArgs) : [];
  }

  const args = parseToolArgsObject(toolArgs);
  if (!args) return [];

  const filePath = stringArg(args, "file_path", "filePath", "path");
  if (!filePath) return [];

  if (toolName === "Edit") {
    const oldString = stringArg(args, "old_string", "oldString") ?? "";
    const newString = stringArg(args, "new_string", "newString") ?? "";
    if (oldString || newString) {
      return [{ filePath, oldContent: oldString, newContent: newString }];
    }
  }

  if (toolName === "Write") {
    const content = stringArg(args, "content") ?? "";
    if (content) {
      return [{ filePath, oldContent: "", newContent: content }];
    }
  }

  return [];
}

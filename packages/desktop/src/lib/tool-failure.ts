import type { AgentBlockData } from "@/types/agent-block";
import { shouldGateFullContent } from "@/lib/agent-block-content";
import {
  extractBashOutputFromArgs,
  extractBashResultOutput,
  isFailedToolStatus,
  toolStatusOf,
} from "@/lib/tool-adapter";
import { parseToolArgsObject } from "@/lib/tool-args";

/** Longest reason a one-line view carries; the full output stays in Maximal. */
const MAX_REASON_LENGTH = 200;

export interface ToolCallFailure {
  /** The failure's first line (`Shell command interrupted by user.`), when it gave one. */
  reason: string | undefined;
}

/**
 * Why `call` failed, for the views that keep it to one line; null when it did
 * not. A call fails as the full blocks decide it: its result says so, or, when
 * no result says either way, the call's own `status` (`failed`, as Codex and
 * ACP agents report it). The reason is the result's first line, else the
 * call's own error or output.
 */
export function toolCallFailure(
  call: AgentBlockData,
  result: AgentBlockData | undefined,
): ToolCallFailure | null {
  if (call.type !== "tool_call") return null;
  if (result?.isError !== undefined) {
    return result.isError ? failure(resultReason(result)) : null;
  }
  // A cut wire preview's arguments are partial: they cannot say how it ended.
  if (shouldGateFullContent(call)) return null;
  const args = parseToolArgsObject(call.toolArgs);
  if (!args || !isFailedToolStatus(toolStatusOf(args))) return null;
  return failure(result ? resultReason(result) : argsReason(args));
}

function failure(output: string | undefined): ToolCallFailure {
  return { reason: output ? firstLine(output) : undefined };
}

function resultReason(result: AgentBlockData): string | undefined {
  return extractBashResultOutput(result.content) ?? result.content;
}

/** A call that carries its own outcome: its `error`, else its output (a `!` command's). */
function argsReason(args: Record<string, unknown>): string | undefined {
  const error = args.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    if (typeof error.message === "string") return error.message;
  }
  return extractBashOutputFromArgs(args);
}

/** The first non-blank line, without splitting a long output into every line. */
function firstLine(text: string): string | undefined {
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    const line = text.slice(start, end === -1 ? text.length : end).trim();
    if (line) {
      return line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH - 1)}…` : line;
    }
    if (end === -1) return undefined;
    start = end + 1;
  }
  return undefined;
}

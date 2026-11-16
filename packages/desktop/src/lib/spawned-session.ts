import type { AgentBlockData } from "@/types/agent-block";
import { mcpToolKey, parseMcpTool } from "@/lib/mcp-tool-parser";
import { isSubagentCarrier } from "@/lib/tool-display-policy";
import { isToolArgsObject as isRecord, stringArg } from "@/lib/tool-args";

const SPAWN_SESSION_TOOL = "project_spawn_session";
const SPAWN_SESSION_TOOL_KEY = `cadencr-project:${SPAWN_SESSION_TOOL}`;

/**
 * A `project_spawn_session` call: the agent started another Cadencr
 * conversation. It draws as a sub-agent card that opens that conversation.
 */
export function isSpawnedSessionCarrier(block: Pick<AgentBlockData, "type" | "toolName">): boolean {
  // The suffix check keeps the stream builders' per-block cost to one string
  // compare; only a likely match pays for the MCP identity parse.
  return (
    block.type === "tool_call" &&
    !!block.toolName?.endsWith(SPAWN_SESSION_TOOL) &&
    mcpToolKey(block.toolName) === SPAWN_SESSION_TOOL_KEY
  );
}

/**
 * Any call that launched an agent the transcript shows as its own card: a
 * provider sub-agent or a spawned Cadencr conversation. Such cards never fold
 * into a compact run or a Summary recap.
 */
export function isAgentCardCarrier(block: Pick<AgentBlockData, "type" | "toolName">): boolean {
  return isSubagentCarrier(block) || isSpawnedSessionCarrier(block);
}

/** What the agent asked for, before the spawned conversation reports its own facts. */
export interface SpawnRequest {
  title: string | null;
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  initialMessage: string | null;
}

export function parseSpawnRequest(toolName: string, toolArgs: string | undefined): SpawnRequest {
  const args = parseMcpTool(toolName, toolArgs)?.arguments ?? {};
  const arg = (key: string): string | null => stringArg(args, key)?.trim() || null;
  return {
    title: arg("title"),
    provider: arg("provider"),
    model: arg("model"),
    thinkingLevel: arg("thinking_level"),
    initialMessage: arg("initial_message"),
  };
}

/** The conversation `project_spawn_session` created, read from its tool result. */
export interface SpawnResult {
  featureId: number;
  sessionId: number | null;
  projectId: number | null;
  projectName: string | null;
  crossProject: boolean;
  /** The conversation exists but its first prompt could not be sent. */
  dispatchError: string | null;
}

/**
 * Reads the spawn response out of a tool result, whatever the provider wrapped
 * it in: Claude stores the MCP content array, Codex the whole MCP result
 * (`{content: [...]}`), and either holds the response as JSON text.
 */
export function parseSpawnResult(content: string | undefined): SpawnResult | null {
  if (!content) return null;
  const response = findSpawnResponse(parseJson(content), 0);
  if (!response) return null;
  const project = isRecord(response.project) ? response.project : undefined;
  return {
    featureId: response.featureId as number,
    sessionId: numberValue(response.sessionId),
    projectId: numberValue(project?.id),
    projectName: typeof project?.name === "string" ? project.name : null,
    crossProject: response.crossProject === true,
    dispatchError: typeof response.dispatchError === "string" ? response.dispatchError : null,
  };
}

/** The text a tool result carries (an error message), unwrapped from its MCP content. */
export function spawnResultText(content: string | undefined): string | null {
  if (!content) return null;
  return firstText(parseJson(content), 0) ?? (content.trim() || null);
}

function firstText(value: unknown, depth: number): string | null {
  if (depth > MAX_UNWRAP_DEPTH) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstText(item, depth + 1);
      if (text) return text;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const record = value;
  if (typeof record.text === "string") return record.text.trim() || null;
  return record.content !== undefined ? firstText(record.content, depth + 1) : null;
}

/** Nesting seen in practice is three levels; the cap only guards odd payloads. */
const MAX_UNWRAP_DEPTH = 6;

function findSpawnResponse(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > MAX_UNWRAP_DEPTH) return null;
  if (typeof value === "string") return findSpawnResponse(parseJson(value), depth + 1);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSpawnResponse(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const record = value;
  if (numberValue(record.featureId) != null) return record;
  if (typeof record.text === "string") return findSpawnResponse(record.text, depth + 1);
  if (record.content !== undefined) return findSpawnResponse(record.content, depth + 1);
  return null;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Not JSON: an error message or plain text carries no response.
    return undefined;
  }
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

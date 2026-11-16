import type { AgentBlockData } from "@/types/agent-block";
import { parseToolArgsObject } from "@/lib/tool-args";
import { isFileChangeTool } from "@/lib/tool-adapter";
import {
  clampJsonText,
  clampParsedJsonText,
  clampTailText,
  clampText,
  TRUNCATION_NOTICE,
  type ClampedText,
} from "@/lib/block-content-budget";

const BASH_OUTPUT_DELTA_KEY = "__cadencr_output_delta";

/**
 * Live cap for the accumulated Bash `output` field. The server persists that
 * field tail-truncated to 200 lines / 8 KB (`truncate_bash_output`), so holding
 * megabytes live only to shrink them on reload spends memory on bytes the user
 * cannot get back anyway. 16 KB keeps the live view a superset of what survives
 * a reload without paying for the rest.
 */
const LIVE_BASH_OUTPUT_MAX_CHARS = 16 * 1024;

export function latestValidJsonSnapshot(content: string): string | undefined {
  try {
    JSON.parse(content);
    return content;
  } catch {
    // Fall through to recover the last full JSON object from concatenated snapshots.
  }

  // A clamped accumulator has a notice spliced into it, so the backward scan
  // below would find some *nested* object in the tail and hand it back as the
  // tool's arguments. Refuse to guess — the caller keeps the last snapshot that
  // did parse, which is stale but never wrong.
  if (content.includes(TRUNCATION_NOTICE)) return undefined;

  for (let index = content.lastIndexOf("{"); index >= 0;) {
    const candidate = content.slice(index);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Keep scanning backward.
    }
    const nextSearchStart = index - 1;
    index = nextSearchStart >= 0 ? content.lastIndexOf("{", nextSearchStart) : -1;
  }
  return undefined;
}

/**
 * Every streamed delta lands here, so this is where an unbounded turn turns
 * into the multi-megabyte blocks production is full of. Each merge path is
 * capped; callers propagate `truncated` onto the block so the UI can say so.
 */
export function mergeToolContent(
  existing: AgentBlockData,
  incoming: string,
  action: string,
): ClampedText {
  if (shouldMergeObjectDeltas(existing.toolName) && action !== "replace") {
    const merged = mergeJsonObjects(existing.toolArgs || existing.content, incoming);
    if (merged) return merged;
  }
  if (action === "replace") return clampJsonText(incoming);
  const combined = existing.content + incoming;
  // Tool content accumulates as partial JSON fragments, which `clampJsonText`
  // knows not to splice into. Prose has no such constraint.
  return isToolBlock(existing) ? clampJsonText(combined) : clampText(combined);
}

/** Publish one scanner-delimited snapshot, parsing its potentially large JSON only once. */
export function mergeCompletedToolSnapshot(
  existing: AgentBlockData,
  snapshot: string,
): ClampedText | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot);
  } catch {
    return undefined;
  }
  if (shouldMergeObjectDeltas(existing.toolName)) {
    const base = parseToolArgsObject(existing.toolArgs);
    if (base && isJsonObject(parsed)) return mergeParsedJsonObjects(base, parsed);
  }
  return clampParsedJsonText(snapshot, parsed);
}

function isToolBlock(block: AgentBlockData): boolean {
  return block.type === "tool_call" || block.type === "tool_result";
}

function mergeJsonObjects(baseJson: string, deltaJson: string): ClampedText | undefined {
  const base = parseToolArgsObject(baseJson);
  const delta = parseToolArgsObject(deltaJson);
  if (!base || !delta) return undefined;
  return mergeParsedJsonObjects(base, delta);
}

function mergeParsedJsonObjects(
  base: Record<string, unknown>,
  delta: Record<string, unknown>,
): ClampedText {
  const nextDelta = { ...delta };
  const outputDelta = nextDelta[BASH_OUTPUT_DELTA_KEY];
  delete nextDelta[BASH_OUTPUT_DELTA_KEY];
  if (typeof outputDelta === "string") {
    const priorOutput = typeof base.output === "string" ? base.output : "";
    // Clamp the accumulated field, not the envelope, so the JSON stays parseable
    // for the renderers.
    const output = clampTailText(priorOutput + outputDelta, LIVE_BASH_OUTPUT_MAX_CHARS);
    const merged = { ...base, ...nextDelta, output: output.text };
    const clamped = clampParsedJsonText(JSON.stringify(merged), merged);
    return { text: clamped.text, truncated: output.truncated || clamped.truncated };
  }
  const merged = { ...base, ...nextDelta };
  return clampParsedJsonText(JSON.stringify(merged), merged);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shouldMergeObjectDeltas(toolName: string | undefined): boolean {
  return toolName === "Bash" || isFileChangeTool(toolName);
}

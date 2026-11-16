import type { AgentBlockData } from "@/types/agent-block";
import {
  BASH_OUTPUT_KEYS,
  extractBashCommandFromArgs,
  extractBashOutputFromArgs,
} from "./tool-adapter";
import { TRUNCATION_NOTICE } from "./block-content-budget";
import { parseToolArgsObject } from "./tool-args";

// A byte-capped server tail may itself be one clipped line. Keep those values
// behind the explicit full-content gate, just like truncated command arguments.
// Advancing the server's byte cutoff to a UTF-8 boundary can drop up to 3 bytes.
const MAX_PREVIEW_LINE_BYTES = 8 * 1024 - 3;
const TRUNCATION_MARKERS = [
  TRUNCATION_NOTICE,
  "… [preview truncated; expand to load full content]",
];

const eligibility = new WeakMap<AgentBlockData, { content: string; allowed: boolean }>();

/** Reuse the guard for unchanged history rows during streaming list updates. */
export function canRenderBashPreview(block: AgentBlockData): boolean {
  const content = block.toolArgs ?? block.content;
  const cached = eligibility.get(block);
  if (cached?.content === content) return cached.allowed;
  const allowed = readableBashPreview(content);
  eligibility.set(block, { content, allowed });
  return allowed;
}

/** Only readable commands with bounded output lines can retain the Bash card. */
function readableBashPreview(content: string): boolean {
  const args = parseToolArgsObject(content);
  if (!args) return false;
  const command = extractBashCommandFromArgs(args);
  const output = extractBashOutputFromArgs(args);
  if (!command || output === undefined) return false;
  const metadata = JSON.stringify(
    Object.fromEntries(Object.entries(args).filter(([key]) => !BASH_OUTPUT_KEYS.has(key))),
  );
  if (TRUNCATION_MARKERS.some((marker) => metadata.includes(marker))) return false;
  const encoder = new TextEncoder();
  return ![command, output].some((text) =>
    text.split("\n").some((line) => encoder.encode(line).length >= MAX_PREVIEW_LINE_BYTES),
  );
}

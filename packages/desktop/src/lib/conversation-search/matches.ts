import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import { DEFAULT_BASH_LINES } from "@/components/BashBlock";
import { extractBashCommand, extractBashOutput, extractBashResultOutput } from "@/lib/tool-adapter";

/** Keep only the last `max` lines — tool output renders collapsed to its tail. */
function lastLines(text: string, max: number): string {
  const lines = text.split("\n");
  return lines.length > max ? lines.slice(-max).join("\n") : text;
}

/**
 * One occurrence of the query inside the conversation, in document order.
 *
 * `rowIndex` is the index into the Virtuoso `data` (the display-item list) so
 * navigation can `scrollToIndex` straight to the (possibly off-screen) row.
 * `occurrenceInBlock` lets the highlighter pick the right occurrence inside a
 * block that contains the query more than once.
 */
export interface ConversationMatch {
  blockId: string;
  rowIndex: number;
  occurrenceInBlock: number;
}

/**
 * Text searched for a given block. We search the underlying transcript text
 * (not the rendered markdown) so off-screen rows — which mount and render in
 * full once scrolled to — are still findable.
 *
 * Bash is the exception: the row renders only the command plus the output's last
 * {@link DEFAULT_BASH_LINES} lines (see `BashBlock`). Searching the whole output
 * would count hundreds of occurrences that aren't in the DOM, inflating the
 * count and making navigation land repeatedly on the last visible match. So we
 * search exactly what the row shows: the command and that visible output tail.
 *
 * That output has to be resolved the same way `AgentBlock` resolves it for
 * rendering — paired `tool_result` first, the tool_call's own payload only as a
 * fallback. Once a command finishes, the backend drops the duplicate copy off
 * the tool_call (`session_tool_output_dedup.rs`), so the result row is the only
 * place the output still lives; reading `toolArgs` alone would silently stop
 * matching completed commands. `tool_result` blocks are filtered out of the
 * display list before it reaches search (`useAgentStreamData`), so they can't
 * make up the difference on their own.
 *
 * Dividers and turn summaries carry no user-authored prose, so they're
 * excluded.
 */
export function blockSearchableText(
  block: AgentBlockData,
  toolResultMap?: ReadonlyMap<string, AgentBlockData>,
): string {
  switch (block.type) {
    case "turn_summary":
    case "compact_divider":
    case "clear_divider":
    case "turn_interrupted":
      return "";
    case "tool_call": {
      const command = extractBashCommand(block.toolArgs);
      const inlineOutput = extractBashOutput(block.toolArgs);
      // Only the provider-normalized Bash tool resolves its text from the
      // result row — that's where dedup moved its output to. Argument shape is
      // not a tool identity: MCP/custom tools may legitimately have `command`
      // or `output` fields while rendering their full arguments.
      if (block.toolName === "Bash") {
        const result = block.toolUseId ? toolResultMap?.get(block.toolUseId) : undefined;
        const output =
          (result ? extractBashResultOutput(result.content) : undefined) ?? inlineOutput;
        const tail = lastLines(output ?? "", DEFAULT_BASH_LINES);
        return [block.toolName, command, tail].filter(Boolean).join(" ");
      }
      // Every other tool renders its name + args; its result is a separate
      // block that search reaches on its own.
      return [block.toolName, block.toolArgs, block.content].filter(Boolean).join(" ");
    }
    default:
      return block.content;
  }
}

function blocksOf(item: DisplayItem): AgentBlockData[] {
  return item.kind === "flow" ? item.blocks : [item.block];
}

export function normalizeConversationQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function countConversationOccurrences(haystackLower: string, needleLower: string): number {
  if (!needleLower) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystackLower.indexOf(needleLower, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needleLower.length;
  }
  return count;
}

/**
 * Flatten every query occurrence across the conversation into an ordered list.
 * Matching is case-insensitive and literal (no regex). An empty or
 * whitespace-only query yields no matches.
 *
 * This full-scan helper is kept for one-shot callers and focused matching
 * tests. The streaming search hook uses `ConversationSearchIndex` instead, so
 * unchanged blocks do not get rescanned or rematerialized on every chunk.
 */
export function computeConversationMatches(
  items: readonly DisplayItem[],
  query: string,
  toolResultMap?: ReadonlyMap<string, AgentBlockData>,
): ConversationMatch[] {
  const needle = normalizeConversationQuery(query);
  if (!needle) return [];

  const matches: ConversationMatch[] = [];
  for (let rowIndex = 0; rowIndex < items.length; rowIndex += 1) {
    for (const block of blocksOf(items[rowIndex])) {
      const occurrences = countConversationOccurrences(
        blockSearchableText(block, toolResultMap).toLowerCase(),
        needle,
      );
      for (let occurrenceInBlock = 0; occurrenceInBlock < occurrences; occurrenceInBlock += 1) {
        matches.push({ blockId: block.id, rowIndex, occurrenceInBlock });
      }
    }
  }
  return matches;
}

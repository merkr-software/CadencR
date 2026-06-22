import type { AgentBlockData } from "@/components/AgentBlock";
import type { DisplayItem } from "@/components/agentStreamDisplay";
import { DEFAULT_BASH_LINES } from "@/components/BashBlock";
import { extractBashCommand, extractBashOutput } from "@/lib/tool-adapter";

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
 * Bash is the exception: its `toolArgs` is a JSON payload that embeds the whole
 * command output, but the row renders only the command plus the output's last
 * {@link DEFAULT_BASH_LINES} lines (see `BashBlock`). Searching the raw payload
 * would count hundreds of occurrences that aren't in the DOM, inflating the
 * count and making navigation land repeatedly on the last visible match. So we
 * search exactly what the row shows: the command and that visible output tail.
 *
 * Dividers and turn summaries carry no user-authored prose, so they're
 * excluded.
 */
export function blockSearchableText(block: AgentBlockData): string {
  switch (block.type) {
    case "turn_summary":
    case "compact_divider":
    case "clear_divider":
      return "";
    case "tool_call": {
      const command = extractBashCommand(block.toolArgs);
      const output = extractBashOutput(block.toolArgs);
      if (command !== undefined || output !== undefined) {
        const tail = lastLines(output ?? "", DEFAULT_BASH_LINES);
        return [block.toolName, command, tail].filter(Boolean).join(" ");
      }
      // Non-Bash tools render their name + args (output, when any, is small).
      return [block.toolName, block.toolArgs, block.content].filter(Boolean).join(" ");
    }
    default:
      return block.content;
  }
}

function blocksOf(item: DisplayItem): AgentBlockData[] {
  return item.kind === "flow" ? item.blocks : [item.block];
}

function countOccurrences(haystackLower: string, needleLower: string): number {
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
 * Cost is O(total transcript length); callers only run it while the search bar
 * is open and debounce the query, so it never touches the streaming hot path.
 */
export function computeConversationMatches(
  items: readonly DisplayItem[],
  query: string,
): ConversationMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches: ConversationMatch[] = [];
  for (let rowIndex = 0; rowIndex < items.length; rowIndex += 1) {
    for (const block of blocksOf(items[rowIndex])) {
      const occurrences = countOccurrences(blockSearchableText(block).toLowerCase(), needle);
      for (let occurrenceInBlock = 0; occurrenceInBlock < occurrences; occurrenceInBlock += 1) {
        matches.push({ blockId: block.id, rowIndex, occurrenceInBlock });
      }
    }
  }
  return matches;
}

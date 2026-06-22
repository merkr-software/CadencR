import type { BlockMutation, ParserSignals, StreamingState } from "./ws-message-processing-core";
import { isRecord, nextSyntheticBlockId } from "./ws-message-processing-utils";

/** Log system messages; `compact_boundary` produces the visible divider. */
export function processSystemMessage(
  msg: Record<string, unknown>,
  state: StreamingState,
  signals: ParserSignals,
): BlockMutation[] {
  const subtype = typeof msg.subtype === "string" ? msg.subtype : "(unknown)";
  console.info(`[AGENT-SYSTEM] ${subtype}`, msg);

  if (subtype !== "compact_boundary") return [];

  signals.compactBoundaryObserved = true;

  const metadata = isRecord(msg.compact_metadata) ? msg.compact_metadata : undefined;
  signals.compactBoundaryTrigger = typeof metadata?.trigger === "string" ? metadata.trigger : null;
  const content = metadata ? JSON.stringify(metadata) : "";

  return [
    {
      action: "append",
      block: {
        id: nextSyntheticBlockId(state, "ws-compact"),
        type: "compact_divider",
        content,
        createdAt: new Date().toISOString(),
      },
    },
  ];
}

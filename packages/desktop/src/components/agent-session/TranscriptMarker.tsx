import type { ReactNode } from "react";
import type { AgentBlockData } from "@/types/agent-block";
import { CompactDivider, ClearDivider } from "@/components/StreamDividers";
import { ErrorBlock } from "@/components/ErrorBlock";
import { TurnInterruptedMarker } from "@/components/TurnInterruptedMarker";
import { WS_RECONNECTING_CODE } from "@/stores/ws-session-types";
import { ConnectionLostNotice } from "./ConnectionLostNotice";

/**
 * Dividers and notices between turns: compaction, clear, a stop, an error, and
 * a dropped connection (a transport notice in the error slot, never a turn error).
 */
export function TranscriptMarker({ block }: { block: AgentBlockData }): ReactNode {
  switch (block.type) {
    case "compact_divider":
      return <CompactDivider metadata={block.content} />;
    case "clear_divider":
      return <ClearDivider previousSessionId={block.content} />;
    case "turn_interrupted":
      return <TurnInterruptedMarker blockId={block.id} cause={block.content} />;
    default:
      if (block.errorCode === WS_RECONNECTING_CODE) return <ConnectionLostNotice />;
      return <ErrorBlock content={block.content} code={block.errorCode} blockId={block.id} />;
  }
}

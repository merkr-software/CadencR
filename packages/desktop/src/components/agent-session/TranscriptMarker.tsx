import type { ReactNode } from "react";
import type { AgentBlockData } from "@/components/agent-block-types";
import { CompactDivider, ClearDivider } from "@/components/StreamDividers";
import { ErrorBlock } from "@/components/ErrorBlock";
import { TurnInterruptedMarker } from "@/components/TurnInterruptedMarker";

/** Dividers and notices between turns: compaction, clear, a stop, an error. */
export function TranscriptMarker({ block }: { block: AgentBlockData }): ReactNode {
  switch (block.type) {
    case "compact_divider":
      return <CompactDivider metadata={block.content} />;
    case "clear_divider":
      return <ClearDivider previousSessionId={block.content} />;
    case "turn_interrupted":
      return <TurnInterruptedMarker blockId={block.id} cause={block.content} />;
    default:
      return <ErrorBlock content={block.content} code={block.errorCode} blockId={block.id} />;
  }
}

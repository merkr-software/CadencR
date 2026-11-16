import type { BlockMutation, ParserSignals, StreamingState } from "./ws-message-processing-core";
import { nextSyntheticBlockId } from "./ws-message-processing-utils";
import { messageDbId } from "./ws-message-identity";
import { isBackgroundLaunchAck } from "@/lib/subagents/subagent-report";
import { isSubagentToolName } from "@/lib/tool-display-policy";

export function processUserMessage(
  msg: Record<string, unknown>,
  state: StreamingState,
  signals: ParserSignals,
): BlockMutation[] {
  const message = msg.message as Record<string, unknown> | undefined;
  const contentArr = message?.content as Array<Record<string, unknown>> | undefined;
  if (!contentArr || !Array.isArray(contentArr)) return [];

  const parentToolUseId = (msg.parent_tool_use_id as string) ?? null;
  const singleResult = contentArr.filter((item) => item.type === "tool_result").length === 1;
  const results: BlockMutation[] = [];

  for (const item of contentArr) {
    if (item.type === "compaction") {
      signals.compactBoundaryObserved = true;
      results.push({
        action: "append",
        block: {
          id: nextSyntheticBlockId(state, "ws-compact"),
          type: "compact_divider",
          content: "",
          createdAt: new Date().toISOString(),
        },
      });
      continue;
    }

    if (item.type !== "tool_result") continue;

    const toolUseId = item.tool_use_id as string;
    const matchingBlock = state.toolUseIdToBlock.get(toolUseId);
    const sourceToolName = matchingBlock?.toolName ?? "unknown";
    const isSubagentResult = isSubagentToolName(sourceToolName);
    const rawContent =
      typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");

    if (isSubagentResult && matchingBlock) {
      // A background subagent's Agent tool_result is only an "Async agent
      // launched" ACK, delivered immediately while the subagent's real work
      // still streams in afterward (interleaved with the main agent). It is NOT
      // completion — treating it as such drops the panel's running state the
      // instant the first event arrives. Flag the block as background so the
      // stream-transition heuristic also leaves it running, and skip appending
      // the ack (it is internal metadata the model is told never to surface).
      // A foreground subagent, by contrast, returns its actual output here — the
      // authoritative "it finished" signal, so complete it now (feedback #2).
      if (isBackgroundLaunchAck(rawContent)) {
        matchingBlock.taskBackground = true;
        continue;
      }
      matchingBlock.taskComplete = true;
    }

    results.push({
      action: "append",
      block: {
        id: resultBlockId(item, singleResult ? msg : undefined, state),
        type: "tool_result",
        content: rawContent,
        isError: item.is_error === true,
        sourceToolName,
        toolUseId,
        parentToolUseId: isSubagentResult
          ? toolUseId
          : (matchingBlock?.parentToolUseId ?? parentToolUseId),
        createdAt: new Date().toISOString(),
      },
    });
  }
  return results;
}

function resultBlockId(
  item: Record<string, unknown>,
  envelope: Record<string, unknown> | undefined,
  state: StreamingState,
): string {
  const id = messageDbId(item.agent_message_id) ?? messageDbId(envelope?.agent_message_id);
  return id === undefined ? nextSyntheticBlockId(state) : `msg-${id}`;
}

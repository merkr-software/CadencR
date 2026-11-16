import { useWsSessionStore } from "@/stores/ws-session-store";

/**
 * Whether `blockId` is the newest block of the session's transcript (turn
 * summaries aside). Recovery affordances (Resume, Continue) only make sense on
 * the turn that just ended, not on history. Boolean selector: re-renders only
 * when the answer flips, not on every streamed token.
 */
export function useIsLatestBlock(wsSessionId: string | null, blockId: string): boolean {
  return useWsSessionStore((state) => {
    if (!wsSessionId) return false;
    const blocks = state.sessions[wsSessionId]?.blocks;
    if (!blocks) return false;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (blocks[index].type === "turn_summary") continue;
      return blocks[index].id === blockId;
    }
    return false;
  });
}

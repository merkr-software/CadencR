import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentBlockData } from "@/types/agent-block";
import {
  AGENT_AUTO_COLLAPSE_DELAY_MS,
  isToolAutoCollapsible,
  verbosityControlsCollapse,
  type AgentVerbosityMode,
} from "@/lib/agent-verbosity";

/** What the verbosity mode asks of a row, before any click of the reader. */
type FoldPolicy = "open" | "folded" | "fold-after-delay";

interface FoldPolicyInput {
  block: AgentBlockData;
  isStreaming: boolean;
  toolResultMap: Map<string, AgentBlockData>;
  verbosityMode: AgentVerbosityMode;
}

/**
 * A block "finishes" on different signals depending on its type:
 *
 *   - `tool_call`: as soon as the matching `tool_result` arrives (the tool
 *     actually ran). The auto-collapse timer starts on result-arrival, NOT
 *     when the agent moves on to the next block — which matches the spec
 *     "3 seconds after they ran" and feels right for long-running Bash.
 *   - `thinking`:  when the streaming cursor moves off the block.
 *
 * Other block types never participate in auto-collapse.
 */
function isBlockFinished(
  block: AgentBlockData,
  isStreaming: boolean,
  toolResultMap: Map<string, AgentBlockData>,
): boolean {
  if (block.type === "thinking") return !isStreaming;
  if (block.type !== "tool_call") return false;
  if (!block.toolUseId) return !isStreaming;
  return toolResultMap.has(block.toolUseId);
}

function foldPolicy(
  verbosityMode: AgentVerbosityMode,
  block: AgentBlockData,
  finished: boolean,
  ranLive: boolean,
): FoldPolicy {
  if (!verbosityControlsCollapse(verbosityMode)) return "open";
  // `isToolAutoCollapsible` covers Bash + file-change tools; thinking is
  // gated on block type because it isn't a tool call.
  const autoCollapsible =
    block.type === "thinking" ||
    (block.type === "tool_call" && isToolAutoCollapsible(block.toolName));
  if (!autoCollapsible) return "open";
  // "Collapsed" mode folds blocks the moment they appear — no "just ran"
  // window, no streaming carve-out.
  if (verbosityMode === "collapsed") return "folded";
  if (!finished) return "open";
  // A historical block (loaded as already finished) has no "just ran" window
  // to honour: it is folded at once so the cold-open stream is scannable.
  return ranLive ? "fold-after-delay" : "folded";
}

interface FoldState {
  /** The policy inputs this state belongs to; a change starts afresh. */
  key: string;
  /** The reader's last click (true = folded), until the policy inputs change. */
  override: boolean | null;
  /** The "just ran" window of a `fold-after-delay` row has elapsed. */
  elapsed: boolean;
}

/**
 * Whether the verbosity mode folds a stream row, known on the row's first
 * render. Deriving it in an effect painted every folded row open for one frame
 * before it collapsed — a layout jump on every mount, Virtuoso recycling
 * included, that the scroll anchor then had to absorb.
 */
export function useFoldPolicy({
  block,
  isStreaming,
  toolResultMap,
  verbosityMode,
}: FoldPolicyInput): { collapsed: boolean; onExpandedChange: (expanded: boolean) => void } {
  const ranLiveRef = useRef(false);
  if (isStreaming) ranLiveRef.current = true;
  const finished = isBlockFinished(block, isStreaming, toolResultMap);
  const toolName = block.type === "tool_call" ? block.toolName : undefined;
  const key = `${block.id}\u0000${block.type}\u0000${toolName ?? ""}\u0000${finished}\u0000${verbosityMode}`;
  const policy = foldPolicy(verbosityMode, block, finished, ranLiveRef.current);

  const [stored, setStored] = useState<FoldState>(() => ({ key, override: null, elapsed: false }));
  let state = stored;
  if (stored.key !== key) {
    // Same-component render-phase update: React re-renders before committing,
    // so the stale fold never reaches the screen.
    state = { key, override: null, elapsed: false };
    setStored(state);
  }

  const waiting = policy === "fold-after-delay" && !state.elapsed;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(
      () => setStored((current) => (current.key === key ? { ...current, elapsed: true } : current)),
      AGENT_AUTO_COLLAPSE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [key, waiting]);

  const onExpandedChange = useCallback((expanded: boolean): void => {
    setStored((current) => ({ ...current, override: !expanded }));
  }, []);

  const collapsedByPolicy = policy === "folded" || (policy === "fold-after-delay" && state.elapsed);
  return { collapsed: state.override ?? collapsedByPolicy, onExpandedChange };
}

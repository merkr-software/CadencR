import { createContext, useContext } from "react";
import type { ResolvedAttentionResult } from "@/hooks/useResolvedAttention";

/** Outside the app shell (a sidebar part rendered alone), nothing needs attention. */
const NO_ATTENTION: ResolvedAttentionResult = {
  entries: [],
  items: [],
  queue: [],
  byProject: new Map(),
  loadingStates: [],
  actions: [],
  actionsLoading: false,
};

/**
 * The attention index resolved once for the app (`SidebarAttentionProvider`).
 * Its own module, free of the stores that resolve it, so a leaf that only
 * reads it (the phone menu button's count) imports nothing else.
 */
export const SidebarAttentionContext = createContext<ResolvedAttentionResult>(NO_ATTENTION);

export function useSidebarAttention(): ResolvedAttentionResult {
  return useContext(SidebarAttentionContext);
}

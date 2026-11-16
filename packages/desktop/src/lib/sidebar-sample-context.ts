import { createContext, useContext } from "react";
import type { FeaturePendingGateResponse } from "@/api/generated";
import type { RowSummary } from "@/lib/sidebar-row-summary";
import type { SidebarSurface } from "@/stores/sidebar-surface-store";

/**
 * What the display options preview feeds the shared row components in place
 * of live data. The sample conversations and projects don't exist on the
 * service, so the few hooks a row reads by id (project color and logo, pending
 * request, gate popover, last reply and todos) answer from here instead of
 * fetching. Null everywhere else.
 */
export interface SidebarSampleData {
  projectColors: ReadonlyMap<number, string>;
  projectIcons: ReadonlyMap<number, string>;
  gates: ReadonlyMap<number, FeaturePendingGateResponse>;
  summaries: ReadonlyMap<number, RowSummary>;
  /** The waiting sample whose popover may open by itself: set by a replay only. */
  mostRecentPendingFeatureId: number | null;
  /** Changes on every replay, so the popover reopens like on a new request. */
  pendingRequestId: string | null;
  /** The preview's surface that owns the gate popover's auto-open. */
  gateOwner: SidebarSurface;
  /** Answering a sample request moves that sample on, nothing is sent. */
  respond: (featureId: number) => void;
}

export const SidebarSampleContext = createContext<SidebarSampleData | null>(null);

export function useSidebarSample(): SidebarSampleData | null {
  return useContext(SidebarSampleContext);
}

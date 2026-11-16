import { useMemo } from "react";
import { useListProjects, type Feature } from "@/api/generated";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { useFeatureTitle } from "@/hooks/useFeatureTitle";
import { SAMPLE_PROJECTS } from "@/lib/sidebar-sample-data";
import { useSidebarSample } from "@/lib/sidebar-sample-context";
import { serverToLocalMs } from "@/lib/server-clock";
import { useSessionStatusStore, type SessionStatusState } from "@/stores/session-status-store";

/** The conversation's record in the attention lists every sidebar surface already holds. */
export function attentionFeature(
  attention: {
    items: readonly { feature: Feature }[];
    actions: readonly { feature: Feature }[];
  },
  featureId: number,
): Feature | undefined {
  return (
    attention.actions.find((action) => action.feature.id === featureId)?.feature ??
    attention.items.find((item) => item.feature.id === featureId)?.feature
  );
}

function useGateFeature(featureId: number): Feature | undefined {
  const { items, actions } = useSidebarAttention();
  return useMemo(
    () => attentionFeature({ items, actions }, featureId),
    [items, actions, featureId],
  );
}

/** What the quick reply's header says about who asks. */
interface GatePopoverSubject {
  title: string | null;
  projectName: string | null;
  /** When the request arrived, on this device's clock; null when unknown. */
  waitingSinceMs: number | null;
}

/**
 * Who asks: the conversation's title (its live rename wins), its project, and
 * how long the request has waited. Read from data the sidebar already has: no
 * request of its own.
 */
export function useGatePopoverSubject(featureId: number): GatePopoverSubject {
  const feature = useGateFeature(featureId);
  const { title: liveTitle } = useFeatureTitle(featureId);
  const sample = useSidebarSample();
  const { data: projects } = useListProjects({ query: { enabled: sample === null } });
  const projectId = feature?.project_id;
  const named: readonly { id: number; name: string }[] | undefined = sample
    ? SAMPLE_PROJECTS
    : projects;
  const projectName =
    projectId == null ? null : (named?.find((project) => project.id === projectId)?.name ?? null);
  const waitingSinceServerMs = useSessionStatusStore((state) =>
    oldestWaitingSince(state, featureId),
  );
  const waitingSinceMs =
    waitingSinceServerMs == null ? null : serverToLocalMs(waitingSinceServerMs);
  return useMemo(
    () => ({ title: liveTitle ?? feature?.title ?? null, projectName, waitingSinceMs }),
    [liveTitle, feature?.title, projectName, waitingSinceMs],
  );
}

function oldestWaitingSince(state: SessionStatusState, featureId: number): number | null {
  let oldest: number | null = null;
  for (const entry of Object.values(state.bySession)) {
    if (entry.featureId !== featureId || entry.status !== "question") continue;
    const since = entry.waitingSinceMs;
    if (since != null && (oldest == null || since < oldest)) oldest = since;
  }
  return oldest;
}

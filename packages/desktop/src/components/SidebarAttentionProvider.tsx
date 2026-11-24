import { useEffect, type ReactElement, type ReactNode } from "react";
import { ProjectAttentionBadges } from "@/components/ProjectAttentionBadges";
import { useResolvedAttention } from "@/hooks/useResolvedAttention";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { reportUnreadRestoreError } from "@/stores/unread-marks-storage";
import {
  SidebarAttentionContext,
  useSidebarAttention,
} from "@/components/sidebar-attention-context";

export { SidebarAttentionContext, useSidebarAttention };

/**
 * Resolves the attention index once for the sidebar and the collapsed rail: the
 * "For me" block (and its action list), the rail and every collapsed project's
 * badges read the same result.
 */
export function SidebarAttentionProvider({ children }: { children: ReactNode }): ReactElement {
  const attention = useResolvedAttention();
  // The sidebar always mounts: it surfaces marks the reload had to drop.
  useEffect(reportUnreadRestoreError, []);
  return (
    <SidebarAttentionContext.Provider value={attention}>
      {children}
    </SidebarAttentionContext.Provider>
  );
}

/**
 * A collapsed project's aggregated badges (G2). Hidden while the row is hovered
 * or focused, where the row actions take the same spot.
 */
export function ProjectRowAttention({ projectId }: { projectId: number }): ReactElement | null {
  const mode = useSidebarOption("projectBadges");
  const { byProject } = useSidebarAttention();
  if (mode === "none") return null;
  return (
    <ProjectAttentionBadges
      counts={byProject.get(projectId)}
      mode={mode}
      className="ml-auto can-hover:group-hover/project:hidden can-hover:group-focus-visible/project:hidden"
    />
  );
}

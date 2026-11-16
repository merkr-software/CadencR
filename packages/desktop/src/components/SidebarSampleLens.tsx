import { useMemo, type ReactElement } from "react";
import type { Project } from "@/api/generated";
import { SidebarLensGroupHeader, STICKY_HEADER_CLASS } from "@/components/SidebarLensGroupHeader";
import { SidebarSampleRow } from "@/components/SidebarSampleRow";
import { useSamplePreview } from "@/components/SidebarSampleProvider";
import { SAMPLE_PROJECTS } from "@/lib/sidebar-sample-data";
import { byActivity } from "@/lib/sidebar-sample-views";
import type { LensContext } from "@/lib/sidebar-lens";
import { NO_MANUAL_ORDER } from "@/lib/sidebar-manual-order";
import { buildSidebarGroups, showsGroupHeaders, type SidebarListMode } from "@/lib/sidebar-views";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useSidebarLensStore } from "@/stores/sidebar-lens-store";

/** The sample projects as the view parser reads projects: by name or id. */
const VIEW_PROJECTS: readonly Project[] = SAMPLE_PROJECTS.map((project) => ({
  id: project.id,
  name: project.name,
  path: "",
  created_at: "",
}));

/**
 * The samples regrouped by a cross-project lens, or filtered by a saved view,
 * as the live list shows them: group headers that fold (and stick, per the
 * option) over block-style rows.
 */
export function SidebarSampleLens({
  mode,
}: {
  mode: Exclude<SidebarListMode, { kind: "tree" }>;
}): ReactElement {
  const preview = useSamplePreview();
  const sort = useSidebarOption("conversationSort");
  const sticky = useSidebarOption("stickyHeaders");
  const folded = useSidebarLensStore((state) => state.folded);
  const toggleGroup = useSidebarLensStore((state) => state.toggleGroup);
  const byId = useMemo(
    () => new Map(preview.rows.map((row) => [row.conversation.feature.id, row])),
    [preview.rows],
  );
  const groups = useMemo(() => {
    const context: LensContext = {
      stateOf: (id) => byId.get(id)?.state ?? "idle",
      worktreeOf: (id) => byId.get(id)?.conversation.worktree,
      now: preview.now,
    };
    return buildSidebarGroups(
      byActivity(preview.rows),
      mode,
      sort,
      NO_MANUAL_ORDER,
      VIEW_PROJECTS,
      context,
    );
  }, [byId, mode, preview.now, preview.rows, sort]);
  const showHeaders = showsGroupHeaders(mode);

  return (
    <div data-sidebar-tree data-sidebar-lens-list className="flex min-w-0 flex-col gap-0.5">
      {mode.kind === "view" && groups[0]?.features.length === 0 && (
        <p className="px-2 py-4 text-center text-xs text-muted-foreground">
          No sample conversation matches this view
        </p>
      )}
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-0.5">
          {showHeaders && (
            <div className={sticky ? STICKY_HEADER_CLASS : undefined}>
              <SidebarLensGroupHeader
                group={group}
                folded={folded.has(group.key)}
                onToggle={toggleGroup}
              />
            </div>
          )}
          {!(showHeaders && folded.has(group.key)) &&
            group.features.map((feature) => {
              const row = byId.get(feature.id);
              return row ? (
                <SidebarSampleRow
                  key={feature.id}
                  row={row}
                  variant="block"
                  isActive={feature.id === preview.activeFeatureId}
                  onSelect={preview.select}
                />
              ) : null;
            })}
        </section>
      ))}
    </div>
  );
}

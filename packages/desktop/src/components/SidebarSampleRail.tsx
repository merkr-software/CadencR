import { useCallback, type ReactElement } from "react";
import type { Feature } from "@/api/generated";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EYEBROW_CLASS } from "@/components/SidebarBlock";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { RailConversation, RailEmptyLine, RailProject } from "@/components/SidebarRail";
import { useSamplePreview } from "@/components/SidebarSampleProvider";
import { SAMPLE_PROJECTS } from "@/lib/sidebar-sample-data";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { SidebarSurfaceContext } from "@/stores/sidebar-surface-store";

/**
 * What the collapsed rail would hold, laid sideways under the preview: the
 * "Collapsed rail" option is otherwise invisible while the sidebar is open.
 */
export function SidebarSampleRail(): ReactElement {
  const { activeFeatureId, select, setProjectExpanded } = useSamplePreview();
  const { items, queue, byProject } = useSidebarAttention();
  const content = useSidebarOption("rail");
  const openConversation = useCallback((feature: Feature) => select(feature.id), [select]);
  const openProject = useCallback(
    (projectId: number) => setProjectExpanded(projectId, true),
    [setProjectExpanded],
  );
  const attentionOnly = content === "attention";
  const shown = attentionOnly ? queue : items;
  return (
    <section
      aria-label="Collapsed rail"
      data-sidebar-sample-rail
      className="mx-1 mt-2 flex flex-col gap-1.5 border-t border-border/60 pt-2"
    >
      <span className={EYEBROW_CLASS}>When collapsed</span>
      <TooltipProvider delayDuration={300}>
        <SidebarSurfaceContext.Provider value="rail">
          <div className="flex flex-wrap gap-1.5 px-1">
            {content === "none" && (
              <span className="text-[11px] text-muted-foreground">
                No rail: the sidebar hides entirely
              </span>
            )}
            {content === "projects" &&
              SAMPLE_PROJECTS.map((project) => (
                <RailProject
                  key={project.id}
                  projectId={project.id}
                  name={project.name}
                  counts={byProject.get(project.id)}
                  onOpen={openProject}
                />
              ))}
            {(content === "conversations" || attentionOnly) &&
              (shown.length === 0 ? (
                <RailEmptyLine attentionOnly={attentionOnly} />
              ) : (
                shown.map((item) => (
                  <RailConversation
                    key={item.feature.id}
                    item={item}
                    isActive={item.feature.id === activeFeatureId}
                    onOpen={openConversation}
                  />
                ))
              ))}
          </div>
        </SidebarSurfaceContext.Provider>
      </TooltipProvider>
    </section>
  );
}

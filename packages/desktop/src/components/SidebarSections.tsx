import type { ReactElement } from "react";
import { ProjectTree } from "@/components/ProjectTree";
import { SidebarForMeSection } from "@/components/SidebarForMeSection";
import { SidebarPinnedConversations } from "@/components/SidebarPinnedConversations";
import { SidebarRecentSection } from "@/components/SidebarRecentSection";
import { SidebarSampleBlock } from "@/components/SidebarSampleBlock";
import { SampleScope } from "@/components/SidebarSampleProvider";
import { SidebarWorkingSection } from "@/components/SidebarWorkingSection";
import type { SidebarSectionId } from "@/lib/sidebar-config";
import { useSidebarOption } from "@/stores/sidebar-config-store";

interface SidebarSectionsProps {
  /** The display options preview: the blocks show samples (the tree swaps its own). */
  showsSamples: boolean;
  activeProjectId: number | null;
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}

/**
 * The blocks and the project list, in the order the user set ("Block order",
 * or by dragging a section's header). Each block still hides while its option
 * is off.
 */
export function SidebarSections(props: SidebarSectionsProps): ReactElement {
  const order = useSidebarOption("sectionOrder");
  return (
    <>
      {order.map((id) => (
        <SidebarSection key={id} id={id} {...props} />
      ))}
    </>
  );
}

function SidebarSection({
  id,
  showsSamples,
  activeProjectId,
  activeFeatureId,
  onSelectFeature,
}: SidebarSectionsProps & { id: SidebarSectionId }): ReactElement {
  if (id === "projects") {
    return (
      <ProjectTree
        activeProjectId={activeProjectId}
        activeFeatureId={activeFeatureId}
        onSelectFeature={onSelectFeature}
      />
    );
  }
  if (showsSamples) {
    return (
      <div data-sidebar-sample className="flex flex-col">
        <SampleScope>
          <SidebarSampleBlock id={id} />
        </SampleScope>
      </div>
    );
  }
  const rowProps = { activeFeatureId, onSelectFeature };
  if (id === "for-me") return <SidebarForMeSection {...rowProps} />;
  if (id === "working") return <SidebarWorkingSection {...rowProps} />;
  if (id === "recent") return <SidebarRecentSection {...rowProps} />;
  return <SidebarPinnedConversations {...rowProps} />;
}

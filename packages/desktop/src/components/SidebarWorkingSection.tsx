import { useMemo, type ReactElement } from "react";
import { LoaderIcon } from "lucide-react";
import { SidebarConversationBlock } from "@/components/SidebarConversationBlock";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { useSidebarOption } from "@/stores/sidebar-config-store";

interface SectionProps {
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}

/**
 * "In progress" (F3): every agent at work, across all projects, longest
 * running first. A conversation leaves as soon as it asks something or
 * finishes: "For me" takes it from there. Off by default.
 */
export function SidebarWorkingSection(props: SectionProps): ReactElement | null {
  return useSidebarOption("workingBlock") ? <WorkingBlock {...props} /> : null;
}

function WorkingBlock({ activeFeatureId, onSelectFeature }: SectionProps): ReactElement | null {
  const { items, loadingStates } = useSidebarAttention();
  const features = useMemo(
    () => items.filter((item) => item.state === "working").map((item) => item.feature),
    [items],
  );
  return (
    <SidebarConversationBlock
      label="In progress"
      icon={LoaderIcon}
      surface="working"
      features={features}
      count={features.length}
      loading={loadingStates.includes("working")}
      empty="No agent at work"
      activeFeatureId={activeFeatureId}
      onSelectFeature={onSelectFeature}
    />
  );
}

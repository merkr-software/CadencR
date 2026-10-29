import { useRef, type ReactElement } from "react";
import { SidebarConfigProvider } from "@/components/SidebarConfigProvider";
import { SampleReplayButton } from "@/components/SidebarSampleBanner";
import { SidebarSampleBlock } from "@/components/SidebarSampleBlock";
import {
  SampleScope,
  SidebarSampleProvider,
  useSidebarSamplePreview,
} from "@/components/SidebarSampleProvider";
import { SidebarSampleRail } from "@/components/SidebarSampleRail";
import { SidebarSampleTree } from "@/components/SidebarSampleTree";
import { SidebarLensHeading } from "@/components/SidebarLensMenu";
import { SECTION_DIVIDER_CLASS } from "@/components/SidebarBlock";
import { cn } from "@/lib/utils";
import { useSidebarSectionExpanded } from "@/hooks/useSidebarSections";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import {
  useSidebarDisplayAttributes,
  useSidebarHighlightAttribute,
} from "@/hooks/useSidebarDisplayAttributes";

/**
 * The sidebar as the options below set it, filled with sample conversations
 * that hit every case: it follows each change live, and outlines what the
 * option under the pointer changes.
 */
export function SidebarPreviewPanel(): ReactElement {
  return (
    <SidebarConfigProvider>
      <SidebarSampleProvider enabled>
        <PreviewFrame />
      </SidebarSampleProvider>
    </SidebarConfigProvider>
  );
}

function PreviewFrame(): ReactElement {
  const frameRef = useRef<HTMLElement>(null);
  const displayAttributes = useSidebarDisplayAttributes();
  useSidebarHighlightAttribute(frameRef);
  const preview = useSidebarSamplePreview();
  return (
    <section
      ref={frameRef}
      aria-label="Sidebar preview"
      {...displayAttributes}
      className="glass-surface flex max-h-[min(36rem,calc(100vh-4rem))] flex-col overflow-hidden rounded-xl border border-border/60 bg-sidebar"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 py-1 pl-3 pr-1 text-[11px] text-muted-foreground">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
        <span
          className="min-w-0 flex-1 truncate font-medium text-foreground/85"
          title="Sample conversations covering every case the options change"
        >
          Live preview
        </span>
        {preview && <SampleReplayButton onReplay={preview.replay} />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <SampleScope>
          <PreviewSections />
          <SidebarSampleRail />
        </SampleScope>
      </div>
    </section>
  );
}

/** The blocks and the projects, in the sidebar's own order and folds. */
function PreviewSections(): ReactElement {
  const order = useSidebarOption("sectionOrder");
  const projectsExpanded = useSidebarSectionExpanded("projects");
  return (
    <>
      {order.map((id) =>
        id === "projects" ? (
          <div key={id} className="not-last:mb-3">
            {/* As the sidebar's Projects header names it. */}
            <div className={cn("mb-2 px-2", SECTION_DIVIDER_CLASS)}>
              <SidebarLensHeading />
            </div>
            {projectsExpanded && (
              <div className="flex min-w-0 flex-col gap-0.5 px-1">
                <SidebarSampleTree />
              </div>
            )}
          </div>
        ) : (
          <SidebarSampleBlock key={id} id={id} />
        ),
      )}
    </>
  );
}

import type { ReactElement } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSidebarSamplePreview } from "@/components/SidebarSampleProvider";
import { useSidebarPreviewStore } from "@/stores/sidebar-preview-store";

/**
 * Says what the sidebar shows while the display options are open: sample
 * conversations covering every case, or the user's own. Part of the preview,
 * so using it keeps the display options open.
 */
export function SidebarSampleBanner(): ReactElement | null {
  const optionsOpen = useSidebarPreviewStore((state) => state.optionsOpen);
  const setShowMine = useSidebarPreviewStore((state) => state.setShowMine);
  const preview = useSidebarSamplePreview();
  if (!optionsOpen) return null;
  return (
    <div
      data-sidebar-sample
      className="mx-1 mb-2 flex shrink-0 items-center gap-1 rounded-lg border border-primary/25 bg-primary/[0.07] py-0.5 pl-2.5 pr-0.5 text-xs"
    >
      <span aria-hidden className="mr-1 size-1.5 shrink-0 rounded-full bg-primary" />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground/85">
        {preview ? "Sample conversations" : "Your conversations"}
      </span>
      {preview && <SampleReplayButton onReplay={preview.replay} iconOnly />}
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground hover:text-foreground"
        onClick={() => setShowMine(preview !== null)}
      >
        {preview ? "Show mine" : "Show samples"}
      </Button>
    </div>
  );
}

/** Plays the samples' last changes again, so flashing and the gate popover can be seen. */
export function SampleReplayButton({
  onReplay,
  iconOnly = false,
}: {
  onReplay: () => void;
  /** Just the icon, where a line has no room for the word (the sidebar banner). */
  iconOnly?: boolean;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size={iconOnly ? "icon-xs" : "xs"}
      aria-label={iconOnly ? "Replay" : undefined}
      title="Play the samples' last changes again: rows flash, the newest request's popover opens"
      className="text-muted-foreground hover:text-foreground"
      onClick={onReplay}
    >
      <Play />
      {!iconOnly && "Replay"}
    </Button>
  );
}

import { useUiTranslation } from "@/lib/i18n/ui";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { SlidersHorizontal } from "lucide-react";
import { AdaptivePopover, AdaptivePopoverContent } from "@/components/PhoneSheetMenu";
import { Button } from "@/components/ui/button";
import { PopoverAnchor } from "@/components/ui/popover";
import { SidebarDisplayOptionsForm } from "@/components/SidebarDisplayOptions";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SidebarSectionId } from "@/lib/sidebar-config";
import { cn } from "@/lib/utils";
import { useSidebarPreviewStore } from "@/stores/sidebar-preview-store";

/** Space between the sidebar's edge and the popover. */
const POPOVER_GAP_PX = 8;

/** Marks the header buttons, so pressing one while open toggles instead of reopening. */
const TRIGGER_ATTRIBUTE = "data-sidebar-options-trigger";

/** Whether a header sits in the live sidebar, which owns the popover (not the settings preview). */
const HasOptionsContext = createContext(false);

/**
 * The display options, opened beside the sidebar and never over it: the rows
 * stay visible, so each change previews live. One popover for the whole
 * sidebar, opened from any section's header: a header button may unmount
 * while it is open (the blocks swap to samples, an option hides a block).
 * The phone's drawer leaves no room beside it: there they open in a bottom
 * sheet, under the drawer's top rows.
 */
export function SidebarDisplayOptionsHost({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}): ReactElement {
  const phone = useIsMobile();
  const open = useSidebarPreviewStore((state) => state.optionsOpen);
  const origin = useSidebarPreviewStore((state) => state.optionsOrigin);
  const closeOptions = useSidebarPreviewStore((state) => state.closeOptions);
  // The sidebar shows samples only while this is open.
  useEffect(() => {
    if (collapsed) closeOptions();
  }, [collapsed, closeOptions]);
  useEffect(() => closeOptions, [closeOptions]);
  // Radix hands the focus back to its own trigger only, which these buttons are
  // not: on Escape, the section whose button takes it back.
  const returnFocusTo = useRef<SidebarSectionId | null>(null);
  // The section they last opened from, kept past `closeOptions` clearing it.
  const lastSection = useRef<SidebarSectionId | null>(null);
  if (origin) lastSection.current = origin.section;
  const virtualRef = useMemo(
    () => ({ current: origin ? { getBoundingClientRect: () => origin.anchor } : null }),
    [origin],
  );
  return (
    <HasOptionsContext.Provider value>
      <AdaptivePopover open={open} onOpenChange={(next) => !next && closeOptions()}>
        {!phone && <PopoverAnchor virtualRef={virtualRef} />}
        <AdaptivePopoverContent
          sheetTitle="Display options"
          sheetRows
          sheetClassName="px-4 pb-4"
          sheetOnCloseAutoFocus={(event) => {
            // The sheet covers the drawer: the focus goes back to the
            // section it opened from, which may have remounted meanwhile.
            event.preventDefault();
            if (lastSection.current) focusTrigger(lastSection.current);
          }}
          side="right"
          align="start"
          sideOffset={POPOVER_GAP_PX}
          className="max-h-(--radix-popover-content-available-height) w-[24rem] overflow-y-auto p-3"
          onInteractOutside={keepOpenForPreview}
          onEscapeKeyDown={() => {
            returnFocusTo.current = origin?.section ?? null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocusTo.current) focusTrigger(returnFocusTo.current);
            returnFocusTo.current = null;
          }}
        >
          <SidebarDisplayOptionsForm />
        </AdaptivePopoverContent>
      </AdaptivePopover>
      {children}
    </HasOptionsContext.Provider>
  );
}

/** A section header's button that opens (or closes) the display options. */
export function SidebarDisplayOptionsButton({
  section,
  className,
}: {
  section: SidebarSectionId;
  className?: string;
}): ReactElement | null {
  const { t } = useUiTranslation();
  const hasOptions = useContext(HasOptionsContext);
  // Only the section the options opened from reads as their trigger.
  const expanded = useSidebarPreviewStore(
    (state) => state.optionsOpen && state.optionsOrigin?.section === section,
  );
  if (!hasOptions) return null;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      {...{ [TRIGGER_ATTRIBUTE]: section }}
      title={t("sidebar.displayOptions.displayOptions", "Display options")}
      aria-label={t("sidebar.displayOptions.displayOptions", "Display options")}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      data-state={expanded ? "open" : "closed"}
      onClick={(event) => toggleOptions(event.currentTarget, section)}
      className={cn("can-hover:data-[state=open]:opacity-100", className)}
    >
      <SlidersHorizontal />
    </Button>
  );
}

function toggleOptions(trigger: HTMLElement, section: SidebarSectionId): void {
  const { optionsOpen, openOptions, closeOptions } = useSidebarPreviewStore.getState();
  if (optionsOpen) closeOptions();
  else openOptions({ anchor: anchorPastSidebar(trigger), section });
}

/**
 * The options button of the section they were opened from, remounted or not;
 * any section's when that one is gone (turned off, hidden as empty).
 */
function focusTrigger(section: SidebarSectionId): void {
  const button =
    document.querySelector<HTMLElement>(`[${TRIGGER_ATTRIBUTE}="${section}"]`) ??
    document.querySelector<HTMLElement>(`[${TRIGGER_ATTRIBUTE}]`);
  button?.focus();
}

/**
 * Using the preview (samples, replay, their popovers) is part of choosing
 * options, and a header button toggles the popover itself.
 */
function keepOpenForPreview(event: Event): void {
  if (
    event.target instanceof Element &&
    event.target.closest(`[data-sidebar-sample], [${TRIGGER_ATTRIBUTE}]`)
  ) {
    event.preventDefault();
  }
}

/** A point just past the sidebar's right edge, level with the trigger. */
function anchorPastSidebar(trigger: HTMLElement): DOMRect {
  const rect = trigger.getBoundingClientRect();
  const sidebar = trigger.closest("[data-app-sidebar]");
  const right = sidebar ? Math.max(sidebar.getBoundingClientRect().right, rect.right) : rect.right;
  return new DOMRect(right, rect.top, 0, rect.height);
}

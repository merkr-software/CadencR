import { useRef, type ReactElement } from "react";
import { Link } from "@tanstack/react-router";
import { PanelLeft, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTrafficLightsAnchor } from "@/hooks/useTrafficLightsAnchor";
import { HAS_MAC_WINDOW_CONTROLS } from "@/lib/mac-window-controls";
import { cn } from "@/lib/utils";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useShortcutLabel } from "@/hooks/useShortcutLabel";

interface SidebarCollapsedChromeProps {
  visible: boolean;
  onExpand: () => void;
}

/**
 * What a page header shows at its leading edge while the sidebar is
 * collapsed. The rail owns expand and Settings, so with a rail this is only
 * the room the macOS traffic lights need: they spill past the 48px rail, and
 * are centered on the row this sits in (see `useTrafficLightsAnchor`), which
 * keeps its expanded height. Without a rail nothing else can expand the
 * sidebar, so the two actions move up here.
 */
export function SidebarCollapsedChrome({
  visible,
  onExpand,
}: SidebarCollapsedChromeProps): ReactElement {
  const isMobile = useIsMobile();
  const railHidden = useSidebarOption("rail") === "none";
  const hasContent = isMobile || railHidden || HAS_MAC_WINDOW_CONTROLS;
  const shown = visible && hasContent;
  const ref = useRef<HTMLDivElement>(null);
  useTrafficLightsAnchor(ref, shown && HAS_MAC_WINDOW_CONTROLS && !isMobile);

  return (
    <div
      ref={ref}
      data-sidebar-collapsed-chrome
      data-visible={shown ? "true" : "false"}
      aria-hidden={shown ? undefined : true}
      inert={shown ? undefined : true}
    >
      {isMobile ? (
        <MobileMenuButton onExpand={onExpand} />
      ) : railHidden ? (
        <TitlebarActions onExpand={onExpand} />
      ) : (
        // With the header's 12px gap, a 20px berth after the lights (they end
        // ~x=72): any closer and a round project badge reads as a fourth light.
        HAS_MAC_WINDOW_CONTROLS && <div className="w-2" />
      )}
    </div>
  );
}

// On phones the brand + settings already live inside the drawer, so the
// collapsed chrome is just a menu button that opens it.
//
// `ml-1` keeps the whole tap target to the right of `MobileDrawer`'s 16px
// edge-swipe strip, which swallows touches to block the browser's back gesture.
function MobileMenuButton({ onExpand }: { onExpand: () => void }): ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="ml-1 size-8 shrink-0"
      title="Open menu"
      onClick={onExpand}
    >
      <PanelLeft className="size-5" />
      <span className="sr-only">Open menu</span>
    </Button>
  );
}

function TitlebarActions({ onExpand }: { onExpand: () => void }): ReactElement {
  const toggleSidebarCombo = useShortcutLabel("toggle-sidebar");
  const actionButtonSize = HAS_MAC_WINDOW_CONTROLS ? "icon-xs" : "icon";
  const actionButtonClass = cn(
    "text-muted-foreground hover:text-foreground",
    !HAS_MAC_WINDOW_CONTROLS && "size-7",
  );
  return (
    <>
      {/* With no rail the header starts at the window edge, so on Mac the
          actions take the rail's place beside the traffic lights. */}
      <div
        className={cn(
          "flex shrink-0 items-center",
          HAS_MAC_WINDOW_CONTROLS ? "ml-14" : "-ml-2 gap-1",
        )}
      >
        <Button
          variant="ghost"
          size={actionButtonSize}
          className={actionButtonClass}
          title={`Expand sidebar (${toggleSidebarCombo})`}
          onClick={onExpand}
        >
          <PanelLeft className="size-4" />
        </Button>
        <Button
          asChild
          variant="ghost"
          size={actionButtonSize}
          className={actionButtonClass}
          title="Settings"
        >
          <Link to="/settings">
            <Settings className="size-4" />
            <span className="sr-only">Settings</span>
          </Link>
        </Button>
      </div>
      <div className="ml-3 mr-1 h-5 w-px self-center bg-border" />
    </>
  );
}

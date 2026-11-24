import { useRef, type ReactElement } from "react";
import { Link } from "@tanstack/react-router";
import { PanelLeft, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PhoneMenuAttentionDot } from "@/components/PhoneMenuAttentionDot";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTrafficLightsAnchor } from "@/hooks/useTrafficLightsAnchor";
import { HAS_MAC_WINDOW_CONTROLS } from "@/lib/mac-window-controls";
import { useUiTranslation } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useShortcutLabel } from "@/hooks/useShortcutLabel";

interface SidebarCollapsedChromeProps {
  visible: boolean;
  onExpand: () => void;
  /** Phone: the menu button counts For me entries (`PhoneMenuAttentionDot`); off on the inbox. */
  menuBadge?: boolean;
  /** Phone: the conversation on screen, left out of that count. */
  currentFeatureId?: number | null;
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
  menuBadge = true,
  currentFeatureId = null,
}: SidebarCollapsedChromeProps): ReactElement {
  const isMobile = useIsMobile();
  const railHidden = useSidebarOption("rail") === "none";
  const hasContent = isMobile || railHidden || HAS_MAC_WINDOW_CONTROLS;
  const shown = visible && hasContent;
  const ref = useRef<HTMLDivElement>(null);
  // Phone layout too (a narrow Electron window): the lights center on the
  // 44px row the menu button sits in, which clears them on its left.
  useTrafficLightsAnchor(ref, shown && HAS_MAC_WINDOW_CONTROLS);

  return (
    <div
      ref={ref}
      data-sidebar-collapsed-chrome
      data-visible={shown ? "true" : "false"}
      aria-hidden={shown ? undefined : true}
      inert={shown ? undefined : true}
    >
      {isMobile ? (
        <MobileMenuButton
          onExpand={onExpand}
          badge={menuBadge}
          currentFeatureId={currentFeatureId}
        />
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
// 44px square: the smallest comfortable target for a finger. In a narrow macOS
// Electron window the traffic lights sit on this row (x≈12 to x≈71), so the
// button starts past them instead: 68px after the row's 12px padding puts its
// edge at x≈80, its glyph at x≈92, the desktop header's 20px berth.
const MOBILE_MENU_BUTTON_INSET = HAS_MAC_WINDOW_CONTROLS ? "ml-[68px]" : "ml-1";

function MobileMenuButton({
  onExpand,
  badge,
  currentFeatureId,
}: {
  onExpand: () => void;
  badge: boolean;
  currentFeatureId: number | null;
}): ReactElement {
  const { t } = useUiTranslation();
  const openMenu = t("sidebar.openMenu", "Open menu");
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("relative size-11 shrink-0", MOBILE_MENU_BUTTON_INSET)}
      title={openMenu}
      onClick={onExpand}
    >
      <PanelLeft className="size-5" />
      <span className="sr-only">{openMenu}</span>
      {badge && <PhoneMenuAttentionDot exceptFeatureId={currentFeatureId} />}
    </Button>
  );
}

function TitlebarActions({ onExpand }: { onExpand: () => void }): ReactElement {
  const { t } = useUiTranslation();
  const settings = t("settings.nav.title", "Settings");
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
          title={t("sidebar.expandWithShortcut", "Expand sidebar ({{shortcut}})", {
            shortcut: toggleSidebarCombo,
          })}
          onClick={onExpand}
        >
          <PanelLeft className="size-4" />
        </Button>
        <Button
          asChild
          variant="ghost"
          size={actionButtonSize}
          className={actionButtonClass}
          title={settings}
        >
          <Link to="/settings">
            <Settings className="size-4" />
            <span className="sr-only">{settings}</span>
          </Link>
        </Button>
      </div>
      <div className="ml-3 mr-1 h-5 w-px self-center bg-border" />
    </>
  );
}

import type { ReactElement } from "react";
import { Link } from "@tanstack/react-router";
import { PanelLeft, Settings } from "lucide-react";
import { AppEnvironmentBadge } from "@/components/AppEnvironmentBadge";
import { CadencrLogo } from "@/components/CadencrLogo";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/useIsMobile";
import { APP_ENVIRONMENT } from "@/lib/app-environment";
import { HAS_MAC_WINDOW_CONTROLS } from "@/lib/mac-window-controls";
import { formatCompactCombo } from "@/lib/shortcuts/format";
import { getRegistryShortcut } from "@/lib/shortcuts/resolve";
import { cn } from "@/lib/utils";

const TOGGLE_SIDEBAR_COMBO = formatCompactCombo(getRegistryShortcut("toggle-sidebar").keys);

interface SidebarCollapsedChromeProps {
  visible: boolean;
  onExpand: () => void;
}

export function SidebarCollapsedChrome({
  visible,
  onExpand,
}: SidebarCollapsedChromeProps): ReactElement {
  const isMobile = useIsMobile();
  const actionButtonSize = HAS_MAC_WINDOW_CONTROLS ? "icon-xs" : "icon";
  const actionButtonClass = cn(
    "text-muted-foreground hover:text-foreground",
    !HAS_MAC_WINDOW_CONTROLS && "size-7",
  );
  // On phones the brand + settings already live inside the drawer, so the
  // collapsed chrome is just a menu button that opens it. Keeping the full
  // logo here would eat the narrow topbar.
  //
  // `ml-1` (rather than the desktop `-ml-1`) keeps the whole tap target to the
  // right of `MobileDrawer`'s 16px edge-swipe strip, which swallows touches to
  // block the browser's back gesture.
  const content = isMobile ? (
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
  ) : (
    <>
      {/* Mac actions use top padding to sit below the traffic lights while the
          sibling brand remains centered against the feature title. */}
      <div
        className={cn(
          "-ml-2 flex shrink-0 items-center gap-2",
          HAS_MAC_WINDOW_CONTROLS && "md:-ml-3",
        )}
      >
        <div
          className={cn(
            "flex items-center",
            HAS_MAC_WINDOW_CONTROLS ? "h-12 gap-0 pt-3 pl-0.5" : "gap-1",
          )}
        >
          <Button
            variant="ghost"
            size={actionButtonSize}
            className={actionButtonClass}
            title={`Expand sidebar (${TOGGLE_SIDEBAR_COMBO})`}
            onClick={onExpand}
          >
            <PanelLeft className="size-4" />
          </Button>
          <Link to="/settings">
            <Button
              variant="ghost"
              size={actionButtonSize}
              className={actionButtonClass}
              title="Settings"
            >
              <Settings className="size-4" />
              <span className="sr-only">Settings</span>
            </Button>
          </Link>
        </div>
        <div className="flex items-center">
          <CadencrLogo className="mr-2 size-9 shrink-0 -translate-y-px" />
          <span className="font-brand text-xl font-extrabold uppercase leading-none tracking-widest">
            Cadencr
          </span>
          <AppEnvironmentBadge className="ml-1 self-start" environment={APP_ENVIRONMENT} />
        </div>
      </div>
      <div className="ml-4 mr-1 h-5 w-px self-center bg-border" />
    </>
  );

  return (
    <div
      data-sidebar-collapsed-chrome
      data-visible={visible ? "true" : "false"}
      aria-hidden={visible ? undefined : true}
      inert={visible ? undefined : true}
    >
      {content}
    </div>
  );
}

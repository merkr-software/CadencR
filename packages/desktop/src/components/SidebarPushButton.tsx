import { type ReactElement } from "react";
import { BellRing, BellOff } from "lucide-react";
import { SIDEBAR_FOOTER_PILL_CLASS } from "@/lib/changelog";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { cn } from "@/lib/utils";

/**
 * Quick per-device push toggle in the sidebar footer, so a remote user can
 * mute/unmute background notifications without opening Settings. Remote/PWA only
 * (the desktop shell uses native OS notifications). Rendered only when push is
 * actionable (on/off); the explanatory states — unsupported, iOS-needs-install,
 * denied — stay in Settings → Notifications so the footer isn't cluttered with a
 * dead control.
 */
export function SidebarPushButton(): ReactElement | null {
  const { state, busy, toggle } = usePushNotifications();

  if (!isBrowserRemote()) return null;
  if (state !== "on" && state !== "off") return null;

  const on = state === "on";
  const title = on
    ? "Background notifications on — tap to disable on this device"
    : "Background notifications off — tap to enable on this device";

  return (
    <button
      type="button"
      data-nav-item
      onClick={() => void toggle(!on)}
      disabled={busy}
      title={title}
      aria-label={title}
      aria-pressed={on}
      className={cn(
        SIDEBAR_FOOTER_PILL_CLASS,
        on ? "text-[var(--acc-green)]" : "text-foreground/80",
      )}
    >
      <span className="flex items-center gap-2">
        {on ? <BellRing className="size-4 shrink-0" /> : <BellOff className="size-4 shrink-0" />}
        <span>{on ? "Notifications on" : "Notifications off"}</span>
      </span>
    </button>
  );
}

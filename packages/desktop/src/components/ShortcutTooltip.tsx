import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { KbdShortcut } from "@/components/KbdShortcut";
import { focusFollowedKeyboardNavigation } from "@/lib/focus-navigation";
import { useUiTranslation } from "@/lib/i18n/ui";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";

interface ShortcutTooltipProps {
  label: string;
  /** Richer bubble body than `label`, which still names the tooltip for assistive tech. */
  content?: ReactNode;
  keys?: string[];
  children: ReactNode;
  /** Align tooltip to the right edge instead of centering */
  alignRight?: boolean;
  /** Align tooltip to the left edge instead of centering (useful when the trigger sits near the viewport's left edge) */
  alignLeft?: boolean;
  /** Show tooltip above the trigger instead of below */
  above?: boolean;
  /**
   * Render the bubble to the right of the trigger instead of below — used
   * for narrow vertical rails where the below-the-trigger area is too
   * cramped or overlaps neighboring panes. Mutually exclusive with
   * `above`/`alignLeft`/`alignRight`.
   */
  toRight?: boolean;
  /** Render the bubble to the left of the trigger (a rail on the right edge). */
  toLeft?: boolean;
  /** Additional class name for the wrapper div */
  className?: string;
  /**
   * When true, the tooltip is force-hidden and ignores hover events.
   * After a `true → false` transition, the tooltip stays hidden until the
   * cursor actually leaves the trigger and re-enters — this avoids the
   * spurious flash that happens when a wrapped popover closes and the
   * cursor ends up over the trigger button (e.g. model picker selection).
   */
  disabled?: boolean;
}

/**
 * Tooltip shown on hover. Radix owns portal placement, collision detection,
 * and viewport clamping so ancestor overflow cannot clip the bubble.
 */
export function ShortcutTooltip({
  label,
  content,
  keys,
  children,
  alignRight,
  alignLeft,
  above,
  toRight,
  toLeft,
  className,
  disabled,
}: ShortcutTooltipProps) {
  const { t } = useUiTranslation();
  const [visible, setVisible] = useState(false);
  const suppressUntilLeaveRef = useRef(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!disabled) return;
    setVisible(false);
    suppressUntilLeaveRef.current = true;
  }, [disabled]);

  function show(): void {
    if (disabled || isMobile || suppressUntilLeaveRef.current) return;
    setVisible(true);
  }

  /**
   * Decided per pointer, not per device: a finger never opens the bubble, even
   * on a screen that also has a mouse or trackpad (an iPad with a trackpad, a
   * touchscreen laptop). A tap fires a compatibility mouseenter and no
   * mouseleave, so listening to mouse events would open the bubble and leave it
   * stuck.
   */
  function handlePointerEnter(event: PointerEvent<HTMLDivElement>): void {
    if (event.pointerType === "touch") return;
    show();
  }

  function hide(): void {
    suppressUntilLeaveRef.current = false;
    setVisible(false);
  }

  /**
   * Only focus the user navigated to counts as intent. Panes restore focus to
   * their active tab trigger on mount, and plain `onFocus` turned that into a
   * tooltip hanging open over the content with the cursor nowhere near it.
   */
  function handleFocus(): void {
    if (!focusFollowedKeyboardNavigation()) return;
    show();
  }

  const side = toRight ? "right" : toLeft ? "left" : above ? "top" : "bottom";
  const align = alignRight ? "end" : alignLeft ? "start" : "center";

  return (
    <TooltipProvider>
      <Tooltip open={visible && !disabled && !isMobile}>
        <TooltipTrigger asChild>
          <div
            className={cn("relative inline-flex", className)}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={hide}
            onFocus={handleFocus}
            onBlur={hide}
          >
            {children}
          </div>
        </TooltipTrigger>
        <TooltipContent
          side={side}
          align={align}
          aria-label={t("shell.shortcutTooltip.accessibleLabel", "{{label}} tooltip", { label })}
          // `open` is controlled: Radix's Esc dismissal must close it here, or a
          // keyboard-opened tooltip would swallow every Esc while focus stays put.
          onEscapeKeyDown={hide}
        >
          {content ?? <span>{label}</span>}
          {keys?.length ? <KbdShortcut keys={keys} size="sm" /> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

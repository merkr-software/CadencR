import type { CSSProperties } from "react";
import { useIsTouchDevice } from "./useIsTouchDevice";

interface TouchSafeTriggerProps {
  disabled?: boolean;
  style?: CSSProperties;
}

const POINTER_TRIGGER_PROPS: TouchSafeTriggerProps = {};
const TOUCH_TRIGGER_PROPS: TouchSafeTriggerProps = {
  disabled: true,
  // Radix sets `-webkit-touch-callout: none` unconditionally, before
  // `props.style`; restore the native long-press link preview.
  style: { WebkitTouchCallout: "default" },
};

/**
 * Props for a Radix `ContextMenuTrigger` wrapping readable content. On touch,
 * Radix opens the menu on a 700ms long-press and cancels the native
 * `contextmenu` event — the same gesture iOS/Android use to start a text
 * selection — so an enabled trigger steals every selection. A disabled one
 * leaves the gesture to the browser.
 */
export function useTouchSafeTriggerProps(): TouchSafeTriggerProps {
  return useIsTouchDevice() ? TOUCH_TRIGGER_PROPS : POINTER_TRIGGER_PROPS;
}

import { useEffect, useRef, type RefObject } from "react";
import type { AttentionState } from "@/lib/sidebar-attention";
import { useSidebarOption } from "@/stores/sidebar-config-store";

/** States worth a glance when a conversation reaches them; working and idle stay quiet. */
const FLASH_STATES: ReadonlySet<AttentionState> = new Set(["waiting", "failed", "unread"]);

/** The keyframes in `sidebar-rows.css`. */
const FLASH_ANIMATION = "sidebar-row-flash";

/** The row (or rail tile) that flashes around a status slot. */
const FLASH_TARGET = "[data-sidebar-flash-target], [data-nav-type='feature']";

/**
 * Flashes the row holding `ref` once when its conversation starts waiting,
 * fails or gets an unread reply (H4). Never on mount, so scrolling a
 * virtualized list or opening the sidebar doesn't light rows up. Paints through
 * a DOM attribute cleared on `animationend`: the row never re-renders for it,
 * and disabled animations end it at once.
 */
export function useAttentionFlash(ref: RefObject<HTMLElement | null>, state: AttentionState): void {
  const enabled = useSidebarOption("flashOnChange");
  const previous = useRef(state);
  useEffect(() => {
    const prior = previous.current;
    previous.current = state;
    if (!enabled || prior === state || !FLASH_STATES.has(state)) return;
    const target = ref.current?.closest<HTMLElement>(FLASH_TARGET);
    if (!target) return;
    const clear = (): void => {
      target.removeAttribute("data-sidebar-flash");
      target.removeEventListener("animationend", onEnd);
    };
    // Child animations bubble here too; only the flash itself ends it.
    const onEnd = (event: AnimationEvent): void => {
      if (event.animationName === FLASH_ANIMATION) clear();
    };
    // The previous effect's cleanup may have just removed a running flash;
    // one style flush (on a state change, never per render) lets it restart.
    void target.offsetWidth;
    target.setAttribute("data-sidebar-flash", state);
    target.addEventListener("animationend", onEnd);
    return clear;
  }, [enabled, ref, state]);
}

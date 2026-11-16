import { useEffect, type RefObject } from "react";

import { registerAutoLayoutTarget } from "./auto-layout-controller";
import { useAutoLayoutActive } from "./auto-layout-mode";

/**
 * Register a mounted feature layout shell with the auto layout controller
 * while its auto layout mode is on.
 * Only shells with splits enabled register: mobile and Unified Agents cards
 * keep their manual behaviour.
 */
export function useAutoLayoutTarget(
  featureId: number,
  shellRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  const { active } = useAutoLayoutActive(featureId, enabled);

  useEffect((): (() => void) | undefined => {
    if (!enabled || !active) return undefined;
    return registerAutoLayoutTarget(featureId, {
      measure: () => {
        const rect = shellRef.current?.getBoundingClientRect();
        return rect && rect.width > 0 ? { width: rect.width, height: rect.height } : null;
      },
    });
  }, [active, enabled, featureId, shellRef]);
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { Feature } from "@/api/generated";
import { applyOrder, reconcileFrozenOrder } from "@/lib/frozen-order";
import { intArraysEqual } from "@/lib/utils";
import { useBusyFeatureIds } from "@/stores/session-status-selectors";

/** Minimum gap between two re-sorts, so a burst of finished turns moves rows once. */
export const RESORT_THROTTLE_MS = 3000;

/** Bumps a token when a turn ends among `featureIds`, at most once per throttle window. */
function useTurnEndResortToken(featureIds: ReadonlySet<number>): number {
  const busyIds = useBusyFeatureIds(featureIds);
  const [token, setToken] = useState(0);
  const previousBusyRef = useRef(busyIds);
  const lastResortRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const stillBusy = new Set(busyIds);
    const turnEnded = previousBusyRef.current.some((id) => !stillBusy.has(id));
    previousBusyRef.current = busyIds;
    if (!turnEnded || timerRef.current) return;
    const wait = Math.max(0, lastResortRef.current + RESORT_THROTTLE_MS - Date.now());
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastResortRef.current = Date.now();
      setToken((value) => value + 1);
    }, wait);
  }, [busyIds]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );
  return token;
}

interface OrderState {
  fetched: readonly number[];
  token: number;
  order: readonly number[];
}

/**
 * Keeps sidebar conversations from reshuffling under the cursor. The backend
 * sorts by latest user message, so sending a prompt would jump the row to the
 * top mid-click. Rows instead hold their place (new ones appear on top) and the
 * list adopts the canonical order only when a turn ends (throttled), plus on
 * mount.
 */
export function useStableFeatureOrder(features: readonly Feature[]): readonly Feature[] {
  const fetched = useMemo(() => features.map((feature) => feature.id), [features]);
  const featureIds = useMemo(() => new Set(fetched), [fetched]);
  const resortToken = useTurnEndResortToken(featureIds);
  const [state, setState] = useState<OrderState>(() => ({
    fetched,
    token: resortToken,
    order: fetched,
  }));
  let current = state;
  // Derive the next order during render (React's "adjust state on prop change"
  // pattern) so a new list never paints in the stale order for a frame. Compare
  // ids, not array identity: callers may pass a fresh `[]` on every render.
  if (state.token !== resortToken || !intArraysEqual(state.fetched, fetched)) {
    const order =
      state.token !== resortToken ? fetched : reconcileFrozenOrder(state.order, fetched);
    current = { fetched, token: resortToken, order };
    setState(current);
  }
  const { order } = current;
  return useMemo(() => applyOrder(features, order), [features, order]);
}

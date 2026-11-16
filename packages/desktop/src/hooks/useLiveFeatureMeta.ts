/**
 * Live per-feature WS metadata (auto-naming title + in-progress flag) for the
 * sidebar, without re-rendering on every stream delta.
 *
 * The WS session store returns a fresh `sessions` object on every mutation, so a
 * naive `useWsSessionStore((s) => s.sessions)` re-reconciles the whole
 * non-virtualized feature list on EVERY delta of ANY session. The sidebar only
 * reads `featureTitle` and `isAutoNaming`, which change rarely. This subscribes
 * imperatively (like `usePowerBusySignal`) and only bumps React state when the
 * derived meta actually changes.
 */

import { useEffect, useState } from "react";
import { useWsSessionStore } from "@/stores/ws-session-store";
import type { SessionEntry } from "@/stores/ws-session-types";

export interface LiveFeatureMeta {
  featureTitle: string | null;
  isAutoNaming: boolean;
}

/** Flat snapshot keyed by ws session id, holding only sessions with live meta. */
export type LiveFeatureMetaMap = Record<string, LiveFeatureMeta>;

function deriveLiveMeta(sessions: Record<string, SessionEntry>): LiveFeatureMetaMap {
  const out: LiveFeatureMetaMap = {};
  for (const [id, entry] of Object.entries(sessions)) {
    // Skip the common case (no live title, not naming) so the snapshot stays
    // small and equality is cheap.
    if (entry.featureTitle != null || entry.isAutoNaming) {
      out[id] = { featureTitle: entry.featureTitle, isAutoNaming: entry.isAutoNaming };
    }
  }
  return out;
}

function metaEqual(a: LiveFeatureMetaMap, b: LiveFeatureMetaMap): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    const av = a[key];
    const bv = b[key];
    if (!bv || av.featureTitle !== bv.featureTitle || av.isAutoNaming !== bv.isAutoNaming) {
      return false;
    }
  }
  return true;
}

const NO_LIVE_META: LiveFeatureMetaMap = {};

/** `enabled: false` skips the store subscription and reads as no live meta. */
export function useLiveFeatureMeta(enabled = true): LiveFeatureMetaMap {
  const [snapshot, setSnapshot] = useState<LiveFeatureMetaMap>(() =>
    enabled ? deriveLiveMeta(useWsSessionStore.getState().sessions) : NO_LIVE_META,
  );

  useEffect(() => {
    if (!enabled) return;
    const update = (sessions: Record<string, SessionEntry>): void => {
      setSnapshot((prev) => {
        const next = deriveLiveMeta(sessions);
        return metaEqual(prev, next) ? prev : next;
      });
    };
    // Re-sync at mount: sessions may have changed between the initial render and
    // the effect firing.
    update(useWsSessionStore.getState().sessions);
    return useWsSessionStore.subscribe((state) => update(state.sessions));
  }, [enabled]);

  return enabled ? snapshot : NO_LIVE_META;
}

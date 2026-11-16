import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_NOTCH_PREFS,
  isNotchPreview,
  type NotchGeometry,
  type NotchPrefs,
  type NotchNotification,
  type NotchSnapshot,
} from "@/shared/notch";
import { notchBridge } from "./notch-bridge";

const MAX_QUEUED_PEEKS = 4;
/** Hover must settle this long before the island opens — passing through the menu bar shouldn't. */
const HOVER_INTENT_MS = 70;
/** Leaving briefly (a diagonal toward a row) must not slam the panel shut. */
const HOVER_GRACE_MS = 280;
/** A snooze ends on the wall clock, checked this often (timers stall while the Mac sleeps). */
const SNOOZE_CHECK_MS = 30_000;

export interface NotchFeed {
  snapshot: NotchSnapshot;
  geometry: NotchGeometry | null;
  prefs: NotchPrefs;
  /** Pointer over the island, debounced: intent on the way in, grace on the way out. */
  engaged: boolean;
  peek: NotchNotification | null;
  dropPeek: (id: string) => void;
  /** Epoch ms the island stays muted until; `null` once it is back. */
  snoozedUntil: number | null;
  /** Main closed the island under the pointer: drop it now rather than after the leave grace. */
  settle: () => void;
  /** Close the island under the pointer (main lets go of it until the pointer leaves). */
  release: () => void;
  error: string | null;
  reportError: (error: unknown) => void;
}

export function useNotchFeed(): NotchFeed {
  const [snapshot, setSnapshot] = useState<NotchSnapshot>({ agents: [] });
  const [geometry, setGeometry] = useState<NotchGeometry | null>(null);
  const [prefs, setPrefs] = useState<NotchPrefs>(DEFAULT_NOTCH_PREFS);
  const [hovering, setHovering] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [queue, setQueue] = useState<NotchNotification[]>([]);
  const [snoozedUntil, setSnoozedUntil] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reportError = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  useEffect(() => {
    const bridge = notchBridge();
    const offs = [
      bridge.onSnapshot(setSnapshot),
      bridge.onGeometry(setGeometry),
      bridge.onPrefs(setPrefs),
      bridge.onHover(setHovering),
      bridge.onSnooze((until) => {
        setSnoozedUntil(until);
        // Muted news is dropped, not deferred.
        if (until != null) setQueue((current) => current.filter(isNotchPreview));
      }),
      bridge.onNotification((notification) =>
        setQueue((current) =>
          [
            // A newer event for the same conversation replaces the older one.
            ...current.filter(
              (queued) =>
                notification.featureId == null || queued.featureId !== notification.featureId,
            ),
            notification,
          ].slice(-MAX_QUEUED_PEEKS),
        ),
      ),
    ];
    bridge
      .ready()
      .then((initial) => {
        setGeometry(initial.geometry);
        setSnapshot(initial.snapshot);
        setPrefs(initial.prefs);
        setSnoozedUntil(initial.snoozedUntil);
      })
      .catch(reportError);
    return () => offs.forEach((off) => off());
  }, [reportError]);

  useEffect(() => {
    const timer = setTimeout(
      () => setEngaged(hovering),
      hovering ? HOVER_INTENT_MS : HOVER_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [hovering]);

  // Errors are shown inside the open panel; clear them once it closes.
  useEffect(() => {
    if (!engaged) setError(null);
  }, [engaged]);

  const dropPeek = useCallback((id: string) => {
    setQueue((current) => current.filter((queued) => queued.id !== id));
  }, []);

  const settle = useCallback(() => setEngaged(false), []);
  const release = useCallback(() => {
    notchBridge().collapse().then(settle).catch(reportError);
  }, [reportError, settle]);

  useEffect(() => {
    if (snoozedUntil == null) return;
    const timer = setInterval(() => {
      if (Date.now() >= snoozedUntil) setSnoozedUntil(null);
    }, SNOOZE_CHECK_MS);
    return () => clearInterval(timer);
  }, [snoozedUntil]);

  return {
    snapshot,
    geometry,
    prefs,
    engaged,
    peek: queue[0] ?? null,
    dropPeek,
    snoozedUntil,
    settle,
    release,
    error,
    reportError,
  };
}

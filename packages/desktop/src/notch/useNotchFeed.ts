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
import { uiI18n } from "@/shared/ui-i18n";

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

function useSnoozeDeadline() {
  const [until, setUntil] = useState<number | null>(null);
  useEffect(() => {
    if (until == null) return;
    const timer = setInterval(() => {
      if (Date.now() >= until) setUntil(null);
    }, SNOOZE_CHECK_MS);
    return () => clearInterval(timer);
  }, [until]);
  return [until, setUntil] as const;
}

export function useNotchFeed(): NotchFeed {
  const [snapshot, setSnapshot] = useState<NotchSnapshot>({ agents: [] });
  const [geometry, setGeometry] = useState<NotchGeometry | null>(null);
  const [prefs, setPrefs] = useState<NotchPrefs>(DEFAULT_NOTCH_PREFS);
  const [hovering, setHovering] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [queue, setQueue] = useState<NotchNotification[]>([]);
  const [snoozedUntil, setSnoozedUntil] = useSnoozeDeadline();
  const [error, setError] = useState<string | null>(null);

  const reportError = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  useEffect(() => {
    const bridge = notchBridge();
    let active = true;
    let receivedLocale = false;
    const applyLocale = (locale: string) => {
      if (uiI18n.language === locale) return;
      void uiI18n.changeLanguage(locale).catch((error: unknown) => {
        if (active) reportError(error);
      });
    };
    const offs = [
      bridge.onSnapshot(setSnapshot),
      bridge.onGeometry(setGeometry),
      bridge.onPrefs(setPrefs),
      bridge.onLocale((locale) => {
        receivedLocale = true;
        applyLocale(locale);
      }),
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
        if (!active) return;
        // A live change can arrive while the ready reply is still in flight.
        if (!receivedLocale) applyLocale(initial.locale);
        setGeometry(initial.geometry);
        setSnapshot(initial.snapshot);
        setPrefs(initial.prefs);
        setSnoozedUntil(initial.snoozedUntil);
      })
      .catch((error: unknown) => {
        if (active) reportError(error);
      });
    return () => {
      active = false;
      offs.forEach((off) => off());
    };
  }, [reportError, setSnoozedUntil]);

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

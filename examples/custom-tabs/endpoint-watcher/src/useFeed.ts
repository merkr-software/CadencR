import { useCallback, useEffect, useRef, useState } from "react";
import { toCadencrError, type CadencrError } from "@cadencr/tab-sdk";
import { useCadencr, useVisibility } from "@cadencr/tab-sdk/react";

import { isRepository, loadFeed, type Feed, type FeedResult } from "./github";

export type FeedState =
  | { status: "loading" }
  | { status: "unconfigured" }
  | { status: "error"; error: CadencrError }
  | { status: "ready"; repository: string; result: FeedResult };

const REFRESH_EVERY_MS = 60_000;
const POLL_CHECK_MS = 5_000;

interface LoadOptions {
  /** Read the configuration again and retry the token: the user edits both in
   *  Settings, and the SDK has no "configuration changed" event. */
  recheckSettings: boolean;
  /** Skip the request when the repository is unchanged and the data fresh. */
  onlyIfStale?: boolean;
}

/**
 * The selected feed of the configured repository. It polls every minute while
 * the tab is shown (a hidden tab spends no rate limit), counted from the last
 * load of any kind; coming back into view re-reads the configuration and
 * catches up if the data went stale.
 */
export function useFeed(feed: Feed, enabled: boolean) {
  const client = useCadencr();
  const visible = useVisibility();
  const [state, setState] = useState<FeedState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  const inFlight = useRef(false);
  const loadedAt = useRef(0);
  const repository = useRef<string | null>(null);

  const load = useCallback(
    async ({ recheckSettings, onlyIfStale = false }: LoadOptions) => {
      // A load already on its way is as fresh as this one would be.
      if (onlyIfStale && inFlight.current) return;
      const request = ++latest.current;
      inFlight.current = true;
      try {
        const previous = repository.current;
        if (recheckSettings || previous === null) {
          const { repository: configured } = await client.config.get();
          repository.current = isRepository(configured) ? configured : null;
        }
        const current = repository.current;
        if (request !== latest.current) return;
        const fresh = Date.now() - loadedAt.current < REFRESH_EVERY_MS;
        if (onlyIfStale && fresh && current === previous) return;
        loadedAt.current = Date.now();
        if (current === null) {
          setState({ status: "unconfigured" });
          return;
        }
        setBusy(true);
        const result = await loadFeed(client, current, feed, recheckSettings);
        if (request === latest.current) setState({ status: "ready", repository: current, result });
      } catch (error) {
        if (request === latest.current) setState({ status: "error", error: toCadencrError(error) });
      } finally {
        if (request === latest.current) {
          inFlight.current = false;
          setBusy(false);
        }
      }
    },
    [client, feed],
  );

  // First load, and again for another feed.
  useEffect(() => {
    if (!enabled) return;
    setState({ status: "loading" });
    void load({ recheckSettings: true });
  }, [load, enabled]);

  // Shown again: the user may have just filled in Settings.
  const wasVisible = useRef(visible);
  useEffect(() => {
    const shown = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (enabled && shown) void load({ recheckSettings: true, onlyIfStale: true });
  }, [visible, enabled, load]);

  // A manual refresh pushes the next poll back; a slow request is never doubled.
  useEffect(() => {
    if (!enabled || !visible) return;
    const timer = setInterval(() => {
      const due = Date.now() - loadedAt.current >= REFRESH_EVERY_MS;
      if (due && !inFlight.current) void load({ recheckSettings: false });
    }, POLL_CHECK_MS);
    return () => clearInterval(timer);
  }, [load, enabled, visible]);

  const refresh = useCallback(() => void load({ recheckSettings: true }), [load]);
  return { state, busy, refresh };
}

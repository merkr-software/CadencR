/**
 * Client-local preference: "Prevent sleep while hosting". Persisted in
 * `localStorage` (this is a per-machine choice about *this* computer, not workspace
 * data), mirroring the localStorage + custom-event pattern used elsewhere for
 * UI prefs. Default `false` — hosting must never silently change power
 * behavior until the user opts in.
 *
 * The flag alone does nothing; the assertion is only held while remote hosting
 * is also active on a desktop host — see `useRemoteSleepGuard`.
 */
import { useCallback, useSyncExternalStore } from "react";

const KEY = "cadencr:remote-prevent-sleep";
const EVENT = "cadencr:remote-prevent-sleep-changed";

// Cache the parsed value so `getSnapshot` (called on every render of a consumer,
// incl. the root-mounted `useRemoteSleepGuard`) doesn't hit `localStorage` each
// time and stays referentially stable. Kept fresh by the writer and the
// subscribe listeners below.
let cached: boolean | null = null;

function readFromStorage(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(KEY) === "true";
}

export function readRemotePreventSleep(): boolean {
  if (cached === null) cached = readFromStorage();
  return cached;
}

export function setRemotePreventSleep(value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, value ? "true" : "false");
  cached = value;
  // Notify same-tab subscribers (the native `storage` event only fires in
  // *other* tabs); cross-tab is covered by the `storage` listener below.
  window.dispatchEvent(new CustomEvent(EVENT));
}

function subscribe(callback: () => void): () => void {
  const onChange = (): void => {
    cached = readFromStorage();
    callback();
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === KEY) onChange();
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Reactive `[enabled, setEnabled]` for the toggle. */
export function useRemotePreventSleep(): readonly [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, readRemotePreventSleep, () => false);
  const setValue = useCallback((next: boolean) => setRemotePreventSleep(next), []);
  return [value, setValue] as const;
}

/**
 * Whether this client hosts remote access and can hold a sleep block: the
 * desktop shell itself (Electron's power blocker works on macOS and Linux),
 * never a paired remote browser.
 */
export function canPreventHostSleep(isElectron: boolean, isRemoteBrowser: boolean): boolean {
  return isElectron && !isRemoteBrowser;
}

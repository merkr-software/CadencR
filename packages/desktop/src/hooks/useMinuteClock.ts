import { useSyncExternalStore } from "react";

const TICK_MS = 60_000;
const HOUR_MS = 60 * TICK_MS;

/** The wall clock at minute precision: what every relative label needs. */
function currentMinute(): number {
  return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

let now = currentMinute();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer == null) {
    timer = setInterval(() => {
      now = currentMinute();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || timer == null) return;
    clearInterval(timer);
    timer = null;
  };
}

/**
 * While nothing is subscribed, follow the wall clock (at minute precision, so
 * repeated reads agree). The first subscriber then reads the same value it
 * rendered with instead of forcing a second render.
 */
function getNow(): number {
  if (timer == null) now = currentMinute();
  return now;
}

/**
 * The current time, refreshed once a minute. Every relative timestamp in the
 * sidebar shares this one interval instead of running a timer per row.
 */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, getNow, getNow);
}

function getHour(): number {
  return Math.floor(getNow() / HOUR_MS) * HOUR_MS;
}

function subscribeNever(): () => void {
  return () => {};
}

/**
 * The current time at hour precision, for day-scale cutoffs: it shares the
 * minute interval but re-renders only when the hour turns, and not at all
 * while `enabled` is false.
 */
export function useHourClock(enabled: boolean): number {
  return useSyncExternalStore(enabled ? subscribe : subscribeNever, getHour, getHour);
}

import { useEffect, useMemo, useRef } from "react";

/** A debounced function, with `cancel` to drop the call it is waiting to make. */
export type DebouncedCallback<TArgs extends unknown[]> = ((...args: TArgs) => void) & {
  cancel: () => void;
};

/**
 * Returns a stable callback that defers invocation by `delayMs`. Subsequent
 * calls within the window reset the timer. The latest arguments win — useful
 * for "fire one prefetch after the mouse settles" patterns where a fast
 * cursor sweep across a list would otherwise issue dozens of requests.
 * `cancel` drops a pending call (the pointer left before the delay ran out).
 *
 * The returned function (and its `cancel`) is stable across renders; the
 * latest `callback` reference is captured via ref so consumers don't have to
 * memoize.
 */
export function useDebouncedCallback<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  delayMs: number,
): DebouncedCallback<TArgs> {
  const callbackRef = useRef(callback);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return useMemo(() => {
    const cancel = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
    const debounced = (...args: TArgs): void => {
      cancel();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        callbackRef.current(...args);
      }, delayMs);
    };
    return Object.assign(debounced, { cancel });
  }, [delayMs]);
}

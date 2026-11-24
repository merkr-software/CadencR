import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * A ref that always holds the latest `value`, for a handler read at event
 * time: a memoized child takes the ref (stable) instead of the value, so a
 * value that changes on every render (a streaming message) re-renders nothing.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Listener = (element: Element) => void;

/**
 * One `ResizeObserver` for every watched block: a long transcript mounts many
 * tables and code blocks, and one observer per block would be as many
 * observers. Its callback runs after layout, so reading `scrollWidth` there
 * costs no extra layout pass.
 */
let sharedObserver: ResizeObserver | null = null;
const listeners = new Map<Element, Listener>();

function observer(): ResizeObserver | null {
  if (sharedObserver || typeof ResizeObserver === "undefined") return sharedObserver;
  sharedObserver = new ResizeObserver((entries) => {
    for (const entry of entries) listeners.get(entry.target)?.(entry.target);
  });
  return sharedObserver;
}

function watch(element: Element, listener: Listener): () => void {
  const shared = observer();
  if (!shared) return () => {};
  listeners.set(element, listener);
  shared.observe(element);
  return () => {
    listeners.delete(element);
    shared.unobserve(element);
  };
}

export interface ContentOverflow {
  /** Content wider than the box, by more than a rounding pixel. */
  wide: boolean;
  /** Content taller than the box (a box with a max height). */
  tall: boolean;
}

const NONE: ContentOverflow = { wide: false, tall: false };

function measureOverflow(element: Element, previous: ContentOverflow): ContentOverflow {
  const wide = element.scrollWidth > element.clientWidth + 1;
  const tall = element.scrollHeight > element.clientHeight + 1;
  return wide === previous.wide && tall === previous.tall ? previous : { wide, tall };
}

/**
 * Whether an element's content is wider (or taller) than the element, measured lazily:
 * only when the element (or, through `content`, what it holds) changes size,
 * never per render. A streaming block re-renders on every delta but resizes
 * only when a line or a row lands, and the state flips only when the answer
 * does. `enabled` false watches nothing and answers no overflow.
 *
 * Returns a callback ref for the clipping element; the element's first child
 * is watched too, since a box with a fixed width does not resize when its
 * content grows wider.
 */
export function useContentOverflow(enabled: boolean): ContentOverflow & {
  ref: (element: HTMLElement | null) => void;
} {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [overflow, setOverflow] = useState<ContentOverflow>(NONE);
  const elementRef = useRef<HTMLElement | null>(null);
  const ref = useCallback((next: HTMLElement | null): void => {
    elementRef.current = next;
    setElement(next);
  }, []);

  useEffect(() => {
    if (!enabled || !element) {
      setOverflow(NONE);
      return;
    }
    const measure = (): void => {
      const target = elementRef.current;
      // A hidden workspace lays its blocks out at zero width: keep the last
      // answer rather than flip every block back and forth.
      if (target && target.clientWidth > 0) {
        setOverflow((previous) => measureOverflow(target, previous));
      }
    };
    const stops = [watch(element, measure)];
    const content = element.firstElementChild;
    if (content) stops.push(watch(content, measure));
    return () => stops.forEach((stop) => stop());
  }, [element, enabled]);

  const shown = enabled ? overflow : NONE;
  return useMemo(() => ({ ref, wide: shown.wide, tall: shown.tall }), [ref, shown]);
}

import { useEffect, useMemo, useState, type RefObject } from "react";
import { useWorkspaceActivity } from "@/components/workspace-pool/workspace-activity";

interface RootObserver {
  observer: IntersectionObserver;
  callbacks: Map<Element, (inView: boolean) => void>;
}

// One IntersectionObserver per (scroll-root, rootMargin), shared by every row
// observing against it — a several-hundred-file diff mounts every row, so a
// per-row observer would mean hundreds of observers. The observer is torn down
// once its last row detaches.
const roots = new Map<Element | null, Map<string, RootObserver>>();

function observeInRoot(
  root: Element | null,
  rootMargin: string,
  el: Element,
  onChange: (inView: boolean) => void,
): () => void {
  let byMargin = roots.get(root);
  if (!byMargin) {
    byMargin = new Map();
    roots.set(root, byMargin);
  }
  let entry = byMargin.get(rootMargin);
  if (!entry) {
    const callbacks = new Map<Element, (inView: boolean) => void>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) callbacks.get(e.target)?.(e.isIntersecting);
      },
      { root, rootMargin, threshold: 0 },
    );
    entry = { observer, callbacks };
    byMargin.set(rootMargin, entry);
  }
  const shared = entry;
  shared.callbacks.set(el, onChange);
  shared.observer.observe(el);

  return () => {
    shared.observer.unobserve(el);
    shared.callbacks.delete(el);
    if (shared.callbacks.size === 0) {
      shared.observer.disconnect();
      byMargin.delete(rootMargin);
      if (byMargin.size === 0) roots.delete(root);
    }
  };
}

/**
 * Track whether an element is within (or near) a scroll container's viewport.
 * Returns a callback ref to attach to the observed element and the current
 * in-view boolean.
 *
 * The observer is registered in an effect (not the ref callback) so the scroll
 * `rootRef` — whose own ref callback runs *after* child refs — is already
 * populated by the time we read it. `rootMargin` widens the trigger area so
 * rows just outside the viewport pre-load and there's no visible pop-in.
 */
export function useInViewport(
  rootRef: RefObject<HTMLElement | null>,
  rootMargin = "600px",
): { setRef: (el: HTMLElement | null) => void; inView: boolean } {
  const [el, setRef] = useState<HTMLElement | null>(null);
  const [inView, setInView] = useState(false);
  const activity = useWorkspaceActivity();

  useEffect(() => {
    if (!el) return;
    // A conversation workspace kept mounted but hidden (`WorkspacePool`) sits
    // off screen: its rows keep the state they had, and the observer reports
    // again once it is shown.
    const onChange = (next: boolean): void => {
      if (next || activity.isActive()) setInView(next);
    };
    return observeInRoot(rootRef.current, rootMargin, el, onChange);
  }, [activity, el, rootRef, rootMargin]);

  // Stable return (frontend-perf rule): `setRef` is identity-stable from
  // `useState`, so this only re-creates when `inView` actually flips.
  return useMemo(() => ({ setRef, inView }), [inView]);
}

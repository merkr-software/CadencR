import {
  createElement,
  lazy,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactElement,
} from "react";

/**
 * A lazy chunk that failed to load (the network dropped, or the host was
 * updated and the old chunk is gone). `LazyBoundary` shows these, and only
 * these, in place; any other error keeps going up to the root boundary.
 */
export class LazyChunkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "LazyChunkError";
  }
}

// What each engine says when a dynamic `import()` cannot fetch its module
// (Chromium, WebKit, Firefox), and what Vite's preload helper throws when a
// chunk's stylesheet does not load.
const CHUNK_LOAD_FAILURE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS for /i;

/**
 * Whether `error` says a chunk could not be fetched, as opposed to a module
 * that loaded and then threw while evaluating (a bug, for the root boundary).
 */
export function isChunkLoadFailure(error: unknown): boolean {
  if (error instanceof LazyChunkError) return true;
  return error instanceof Error && CHUNK_LOAD_FAILURE.test(error.message);
}

/** Marks a fetch failure as a `LazyChunkError`; rethrows any other error unchanged. */
function markChunkFailure(error: unknown): never {
  if (error instanceof LazyChunkError || !isChunkLoadFailure(error)) throw error;
  throw new LazyChunkError(error);
}

/**
 * `React.lazy` over a named export, its load failure marked as a
 * `LazyChunkError`. Splits a module that the first paint never shows (a tab
 * body, a dialog, a page) out of the entry chunk; render it under a
 * `LazyBoundary` for its loading and failure states.
 */
export function lazyChunk<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
): LazyExoticComponent<ComponentType<Props>> {
  return lazy(() => load().then((component) => ({ default: component }), markChunkFailure));
}

interface PreloadableChunk<Props extends object> {
  /**
   * Loads the chunk once; a failed load is forgotten so the next `preload`
   * call tries again (the rendered component does not: `React.lazy` keeps
   * the rejection it saw).
   */
  preload: () => Promise<ComponentType<Props>>;
  /**
   * Starts loading; the promise settles with the load and never rejects. A
   * failure is left to `Component`: it loads again when it renders and its
   * `LazyBoundary` reports a failure.
   */
  prefetch: () => Promise<void>;
  /**
   * The component: rendered directly once `preload` has resolved (no
   * Suspense pass, so its first commit is the real one), lazily otherwise.
   */
  Component: (props: Props) => ReactElement;
}

/** A `lazyChunk` that can be loaded ahead of its first render. */
export function preloadableChunk<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
): PreloadableChunk<Props> {
  let loaded: ComponentType<Props> | null = null;
  let pending: Promise<ComponentType<Props>> | null = null;
  const preload = (): Promise<ComponentType<Props>> => {
    pending ??= load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        pending = null;
        return markChunkFailure(error);
      },
    );
    return pending;
  };
  const Lazy = lazyChunk(preload);
  function Component(props: Props): ReactElement {
    // Chosen once per mount: switching from the lazy wrapper to the loaded
    // component later would be a new element type, and remount it.
    const [Loaded] = useState(() => loaded);
    return Loaded ? createElement(Loaded, props) : createElement(Lazy, props);
  }
  const prefetch = (): Promise<void> =>
    // Not reported here: `preload` already forgot the failure, and the first
    // render loads again under its `LazyBoundary`, which reports it (Reload).
    // That render is the last automatic retry: `React.lazy` keeps a rejected
    // load for good, so after it only direct `preload` calls try again.
    preload().then(
      () => undefined,
      () => undefined,
    );
  return { preload, prefetch, Component };
}

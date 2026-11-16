import type { VisualLibrary } from "./visual-document";

/**
 * Sources inlined into HTML visuals, loaded on first use. The frame is offline
 * and runs at an opaque origin, so it can fetch nothing itself: libraries and
 * the Inter font travel inside the document. `visual-lib:*` are virtual
 * modules (electron.vite.config.ts) holding the prebuilt bundles as text.
 */
const LIBRARY_LOADERS: Record<VisualLibrary, () => Promise<{ default: string }>> = {
  d3: () => import("visual-lib:d3"),
  "chart.js": () => import("visual-lib:chart.js"),
};

const cache = new Map<string, Promise<string>>();

function cached(key: string, load: () => Promise<{ default: string }>): Promise<string> {
  let pending = cache.get(key);
  if (!pending) {
    pending = load().then((module) => module.default);
    // A failed chunk load must be retryable, not cached forever.
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}

interface VisualAssets {
  fontDataUrl: string;
  libraries: Partial<Record<VisualLibrary, string>>;
}

export async function loadVisualAssets(names: readonly VisualLibrary[]): Promise<VisualAssets> {
  const [fontDataUrl, ...sources] = await Promise.all([
    cached(
      "font:inter",
      () => import("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?inline"),
    ),
    ...names.map((name) => cached(`lib:${name}`, LIBRARY_LOADERS[name])),
  ]);
  const libraries: Partial<Record<VisualLibrary, string>> = {};
  names.forEach((name, index) => {
    libraries[name] = sources[index];
  });
  return { fontDataUrl, libraries };
}

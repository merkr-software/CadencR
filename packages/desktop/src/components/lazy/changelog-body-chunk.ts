import { lazyChunk } from "./lazy-chunk";

/**
 * The changelog (with its Markdown renderer) from its own chunk, for the
 * update popover and the post-update dialog; render it under a `LazyBoundary`.
 */
export const LazyChangelogBody = lazyChunk(() =>
  import("@/components/ChangelogBody").then((module) => module.ChangelogBody),
);

/**
 * Scroll-viewer "desk" for pages and slides, matched to the PDF view: a
 * transparent desk so the preview's muted backdrop shows through, the same
 * 16px gap / 24px top and bottom margin, and Tailwind's `shadow-md` plus the
 * `ring-black/5` hairline its pages use.
 */
export const PAGE_DESK = {
  background: "transparent",
  gap: 16,
  paddingTop: 24,
  paddingBottom: 24,
  pageShadow:
    "0 0 0 1px rgb(0 0 0 / 0.05), 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
} as const;

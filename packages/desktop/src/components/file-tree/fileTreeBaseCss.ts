/**
 * Shadow-root CSS for every Cadencr file tree, passed as pierre's `unsafeCSS`
 * (its `@layer unsafe` outranks pierre's `@layer base`).
 *
 * Pierre's middle truncation hides clipped glyphs under a "…" marker painted
 * with the tree background, which garbles names on translucent (Frost)
 * surfaces. Its segment grids are flattened into one inline run so the content
 * section's native `text-overflow: ellipsis` truncates the end instead. The
 * git lane uses the mono face so the status letters line up.
 */
export const CADENCR_FILE_TREE_BASE_CSS = `
[data-item-section='content'] {
  white-space: nowrap;
}
[data-item-section='content'] :where(
    [data-truncate-group-container],
    [data-truncate-segment-priority],
    [data-truncate-container],
    [data-truncate-grid],
    [data-truncate-grid] > div,
    [data-truncate-content],
    [data-item-flattened-subitems]
  ) {
  display: inline;
  direction: inherit;
}
[data-item-section='content'] :is(
    [data-truncate-content='overflow'],
    [data-truncate-marker-cell],
    [data-truncate-fill]
  ) {
  display: none;
}
/* Renaming a flattened chain: the parent segments shrink so the input keeps
 * room, as pierre's own segment truncation did. */
[data-item-section='content'] [data-item-flattened-subitems]:has([data-item-rename-input]) {
  display: flex;
}
[data-item-section='content'] [data-item-flattened-subitems]:has([data-item-rename-input]) > [data-item-flattened-subitem] {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-item-section='content'] [data-item-flattened-subitem]:has(> [data-item-rename-input]) {
  flex: 1 0 50%;
}
[data-item-section='git'] {
  font-family: var(--font-mono);
  font-size: 10.5px;
}
`;

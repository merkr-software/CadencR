export const DIFF_UNSAFE_CSS = `
  :host {
    display: block;
    /* Feed Pierre its OWN font tokens so the diff code renders in the exact same
       face + size as the CodeMirror editor. Pierre applies these to the code
       lines via var(--diffs-font-*); its default code fallback ("SF Mono", …,
       "Courier New") resolves to Courier New on iOS (SF Mono isn't exposed by
       name to web content there), which is why the diff didn't match the
       editor's ui-monospace. Header keeps the UI/sans font. */
    --diffs-font-family: var(--font-mono);
    --diffs-header-font-family: var(--font-sans);
    --diffs-font-size: var(--code-font-size);
    --diffs-line-height: 1.65;
  }
  :host(.cadencr-patch-diff-focused) [data-diffs-header] {
    box-shadow: inset 0 0 0 1px var(--primary);
    /* background-color (not the shorthand) so the frost tint layer below
       survives the focused state. */
    background-color: var(--accent);
  }
  [data-diffs-header] {
    position: sticky;
    top: 0;
    z-index: 10;
    min-height: 38px;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar);
    /* Frost themes: --sidebar is near-transparent there, so scrolled diff
       lines bled through the sticky header. Both vars pierce the shadow
       boundary and resolve to none everywhere else (see theme-frost.css). */
    background-image: var(--diff-file-header-tint, none);
    backdrop-filter: var(--diff-file-header-backdrop, none);
    -webkit-backdrop-filter: var(--diff-file-header-backdrop, none);
    color: var(--foreground);
  }
  [data-header-content] { min-width: 0; }
  [data-title], [data-prev-name] {
    min-width: 0;
    font-size: 12px;
  }
  [data-title] bdi, [data-prev-name] bdi {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  [data-metadata] { font-size: 12px; }
  [data-metadata] {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  [data-metadata] slot[name="header-metadata"] {
    order: -1;
  }
  [data-utility-button] {
    background-color: var(--primary);
    color: var(--primary-foreground);
    fill: currentColor;
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--primary-foreground) 18%, transparent);
  }
  [data-utility-button]:hover,
  [data-utility-button]:focus-visible {
    background-color: color-mix(in oklab, var(--primary) 88%, var(--foreground));
    color: var(--primary-foreground);
  }
  :host(.cadencr-patch-diff-inline) [data-code] {
    padding-top: 0;
    padding-bottom: 0;
  }
`;

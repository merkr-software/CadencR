export const CHECKBOX_ATTR = "data-cadencr-stage-checkbox";
export const LOADER_ATTR = "data-cadencr-stage-loader";

const CHECK_MASK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E")`;
const DASH_MASK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3.5' stroke-linecap='round'%3E%3Cpath d='M5 12h14'/%3E%3C/svg%3E")`;

/**
 * Search chrome and status styling for the git diff file tree. Every row here
 * is a change, so the editor tree's git cues turn into noise: folders drop the
 * "contains changes" dot and names stay neutral, leaving the status letter to
 * carry the color. Deleted files read as struck through.
 */
export const GIT_DIFF_TREE_CSS = `
[data-file-tree-search-container] {
  padding: var(--trees-padding-inline);
  margin-bottom: 0;
}
[data-item-contains-git-change='true'] > [data-item-section='git'] {
  visibility: hidden;
}
[data-item-git-status] > [data-item-section='content'] {
  color: inherit;
}
[data-item-git-status='deleted'] > [data-item-section='content'] {
  color: var(--trees-fg-muted);
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklab, currentColor 55%, transparent);
}
`;

/**
 * Stage controls. The checkbox borrows `ui/checkbox.tsx`'s tokens and lucide
 * check/dash glyphs instead of the platform control, which painted a glossy
 * OS checkbox in the middle of the tree. Files without a control keep an
 * empty slot of the same width so names stay aligned.
 */
export const GIT_DIFF_TREE_STAGE_CSS = `
[data-item-section="spacing-item"] {
  border-inline-start-color: transparent !important;
}
[data-item-type="file"] {
  padding-inline-start: 2px;
}
[data-item-type="file"]::before {
  content: "";
  flex: 0 0 23px;
}
[data-item-type="file"]:has(> [${CHECKBOX_ATTR}], > [${LOADER_ATTR}])::before {
  display: none;
}
:is([${CHECKBOX_ATTR}], [${LOADER_ATTR}]) {
  box-sizing: border-box;
  width: 13px;
  height: 13px;
  flex: 0 0 13px;
  margin: 0 6px 0 4px;
  align-self: center;
}
[${CHECKBOX_ATTR}] {
  appearance: none;
  display: grid;
  place-content: center;
  border: 1px solid var(--control-border);
  border-radius: 3.5px;
  background-color: transparent;
  cursor: pointer;
}
[${CHECKBOX_ATTR}]:not(:checked, :indeterminate, :disabled):hover {
  border-color: var(--trees-fg-muted);
}
[${CHECKBOX_ATTR}]:is(:checked, :indeterminate) {
  background-color: var(--primary);
  border-color: var(--primary);
}
[${CHECKBOX_ATTR}]:is(:checked, :indeterminate)::before {
  content: "";
  width: 9px;
  height: 9px;
  background-color: var(--primary-foreground);
  mask: ${CHECK_MASK} center / contain no-repeat;
}
[${CHECKBOX_ATTR}]:indeterminate::before {
  mask-image: ${DASH_MASK};
}
[${CHECKBOX_ATTR}]:focus-visible {
  outline: 2px solid var(--control-focus-ring);
  outline-offset: 1px;
}
[${CHECKBOX_ATTR}]:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
[${LOADER_ATTR}] {
  color: var(--trees-fg-muted);
}
[${LOADER_ATTR}] svg {
  display: block;
  width: 100%;
  height: 100%;
  animation: cadencr-stage-spinner 800ms linear infinite;
}
[data-item-section="decoration"] > span {
  display: inline-flex;
  width: 12px;
  height: 12px;
  flex: 0 0 12px;
  font-size: 0;
  color: var(--trees-git-modified-color);
}
[data-item-section="decoration"] > span::before {
  content: "";
  width: 100%;
  height: 100%;
  background-color: currentColor;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cg fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'/%3E%3Cpath d='M12 9v4'/%3E%3Cpath d='M12 17h.01'/%3E%3C/g%3E%3C/svg%3E") center / contain no-repeat;
}
@keyframes cadencr-stage-spinner {
  to {
    transform: rotate(360deg);
  }
}
`;

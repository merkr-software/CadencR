/**
 * Resize bounds for the global left sidebar, shared by `AppShell` (the panel
 * constraints), `useSidebarController` (clamping the persisted width) and
 * `useToastAnchor` (ignoring the collapse/expand animation's transient widths).
 * The minimum is kept close to DESIGN.md's 268px sidebar width — dragging much
 * narrower leaves the project/feature rows cramped and unreadable.
 */
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 400;
export const SIDEBAR_DEFAULT_WIDTH = 256;

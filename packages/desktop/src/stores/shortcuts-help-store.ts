import { create } from "zustand";

/**
 * UI-only open/closed state for the Keyboard Shortcuts (⌘⇧?) help modal.
 *
 * Lifted out of the root route's local state so the modal can be opened from
 * anywhere — the global shortcut toggles it, and the **Keyboard shortcuts**
 * button in `/settings` opens it — without prop-drilling a setter across
 * routes. The store is the single source of truth; the modal renders once from
 * `RootOverlays` and subscribes here.
 */
interface ShortcutsHelpState {
  open: boolean;
  /** Set the open state explicitly (used as the modal's `onOpenChange`). */
  setOpen: (open: boolean) => void;
  /** Toggle — the global ⌘⇧? shortcut both opens and closes the modal. */
  toggle: () => void;
}

export const useShortcutsHelpStore = create<ShortcutsHelpState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

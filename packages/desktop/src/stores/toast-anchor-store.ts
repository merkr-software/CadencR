/**
 * Where the expanded desktop sidebar wants toasts to stack: just above its
 * footer, flush with the footer pills. Published by `useToastAnchor` from
 * `SidebarFooter`, read by the `<Toaster />` wrapper. `null` (sidebar
 * collapsed, mobile drawer, or not mounted) falls back to top-center.
 */

import { create } from "zustand";
import { shallow } from "zustand/shallow";

/** Viewport pixels: distance from the bottom edge, left edge and stack width. */
export interface ToastAnchor {
  bottom: number;
  left: number;
  width: number;
}

interface ToastAnchorState {
  anchor: ToastAnchor | null;
  setAnchor: (anchor: ToastAnchor | null) => void;
}

export const useToastAnchorStore = create<ToastAnchorState>((set, get) => ({
  anchor: null,
  // Skips equal writes so resize ticks that don't move the anchor re-render nothing.
  setAnchor: (anchor) => {
    if (!shallow(get().anchor, anchor)) set({ anchor });
  },
}));

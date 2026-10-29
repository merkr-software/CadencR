import { create } from "zustand";

import type { PaletteCommand } from "@/lib/command-palette/palette-types";

interface CustomActionPaletteState {
  /** `Run: <action>` commands for the conversation on screen. */
  commands: readonly PaletteCommand[];
}

/**
 * The open conversation's actions, offered by the command palette. The header
 * launcher publishes them while mounted and clears them on unmount, so the
 * palette only lists actions it can run right now (same contract as the
 * shortcut-backed commands in `shortcut-actions.ts`).
 */
export const useCustomActionPaletteStore = create<CustomActionPaletteState>(() => ({
  commands: [],
}));

export function publishCustomActionCommands(commands: readonly PaletteCommand[]): () => void {
  useCustomActionPaletteStore.setState({ commands });
  return () => {
    if (useCustomActionPaletteStore.getState().commands === commands) {
      useCustomActionPaletteStore.setState({ commands: [] });
    }
  };
}

import { create } from "zustand";

/**
 * UI-only state for the host's Remote access dialog: whether it's open, and a
 * one-shot signal to focus the paired-devices section. Lifted out of the
 * sidebar button so the "device connected" toast can open the dialog (and jump
 * straight to the devices list) from outside React via `getState()`.
 *
 * `focusDevicesNonce` is a monotonic counter rather than a boolean: each bump
 * re-triggers the focus effect even when the dialog is already open, so a
 * second connection still re-scrolls.
 */
interface RemoteDialogState {
  open: boolean;
  focusDevicesNonce: number;
  /** Open the dialog; pass `focusDevices` to scroll to the paired-devices list. */
  openDialog: (opts?: { focusDevices?: boolean }) => void;
  /** The dialog scrolled to the devices: the next opening starts at the top. */
  devicesFocused: () => void;
  setOpen: (open: boolean) => void;
}

export const useRemoteDialogStore = create<RemoteDialogState>((set) => ({
  open: false,
  focusDevicesNonce: 0,
  openDialog: (opts) =>
    set((s) => ({
      open: true,
      focusDevicesNonce: opts?.focusDevices ? s.focusDevicesNonce + 1 : s.focusDevicesNonce,
    })),
  devicesFocused: () => set({ focusDevicesNonce: 0 }),
  setOpen: (open) => set({ open }),
}));

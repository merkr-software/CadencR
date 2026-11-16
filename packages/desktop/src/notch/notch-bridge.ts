import type { NotchBridge } from "@/shared/notch";

declare global {
  interface Window {
    cadencrNotch?: NotchBridge;
  }
}

export function notchBridge(): NotchBridge {
  const bridge = window.cadencrNotch;
  if (!bridge) throw new Error("The notch island must run inside its Electron window.");
  return bridge;
}

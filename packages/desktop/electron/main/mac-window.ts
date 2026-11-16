import path from "node:path";
import { app, type BrowserWindow } from "electron";

interface MacWindowAddon {
  preventActivation: (handle: Buffer) => void;
}

let addon: MacWindowAddon | null = null;

function isMacWindowAddon(value: unknown): value is MacWindowAddon {
  return (
    typeof value === "object" &&
    value !== null &&
    "preventActivation" in value &&
    typeof value.preventActivation === "function"
  );
}

/** Built by `electron/mac-native-addon.ts`; shipped by electron-builder's `extraResources`. */
function addonPath(): string {
  const resources = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), "resources");
  return path.join(resources, "native", "mac-window.node");
}

function loadAddon(): MacWindowAddon {
  if (addon) return addon;
  const loaded = { exports: {} as unknown };
  process.dlopen(loaded, addonPath());
  if (!isMacWindowAddon(loaded.exports)) {
    throw new Error("The mac-window addon does not export preventActivation.");
  }
  addon = loaded.exports;
  return addon;
}

/**
 * Make clicks on `win` leave the frontmost app frontmost. Electron's `panel`
 * type only fakes the non-activating style mask, so without this a click
 * activates Cadencr and macOS raises its main window over the user's work.
 */
export function preventAppActivation(win: BrowserWindow): void {
  loadAddon().preventActivation(win.getNativeWindowHandle());
}

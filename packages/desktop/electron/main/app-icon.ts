import path from "node:path";

export const LINUX_DESKTOP_NAME = "cadencr.desktop";

const LINUX_WINDOW_ICON_RELATIVE_PATH = path.join("icons", "512x512.png");

export interface WindowIconPathOptions {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  platform?: NodeJS.Platform;
}

export interface WindowIconOption {
  icon?: string;
}

export function resolveWindowIconPath({
  appPath,
  isPackaged,
  resourcesPath,
  platform = process.platform,
}: WindowIconPathOptions): string | null {
  if (platform !== "linux") return null;
  const root = isPackaged ? resourcesPath : appPath;
  return path.join(root, LINUX_WINDOW_ICON_RELATIVE_PATH);
}

export function windowIconOption(options: WindowIconPathOptions): WindowIconOption {
  const icon = resolveWindowIconPath(options);
  return icon ? { icon } : {};
}

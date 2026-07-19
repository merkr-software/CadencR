import { readFileSync } from "node:fs";

/** Linux package formats that electron-updater can install automatically. */
export type LinuxInstallType = "appimage" | "deb" | "rpm" | "unknown";

/**
 * Detect the packaged Linux target using the same signals as electron-updater.
 *
 * AppImage sets `APPIMAGE` at runtime. electron-builder writes a
 * `resources/package-type` identity file into DEB and RPM installations. Do
 * not infer the package type from the distribution: users can run an AppImage
 * on Ubuntu or install an RPM on openSUSE, and the updater must select the
 * artifact that matches the installation rather than the host distro.
 */
export function detectLinuxInstallType(
  env: NodeJS.ProcessEnv = process.env,
  packageTypePath?: string,
): LinuxInstallType {
  if (env.APPIMAGE) return "appimage";
  if (!packageTypePath) return "unknown";

  try {
    const packageType = readFileSync(packageTypePath, "utf8").trim().toLowerCase();
    if (packageType === "deb" || packageType === "rpm") return packageType;
  } catch {
    return "unknown";
  }
  return "unknown";
}

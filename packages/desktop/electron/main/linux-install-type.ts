import { readFileSync } from "node:fs";

/**
 * How a Linux build of Cadencr was installed. Drives whether the in-app
 * auto-updater is active.
 *
 * - `appimage` → `electron-updater` handles upgrades (signed by us).
 * - `deb` / `rpm` → the system package manager owns updates; the in-app
 *   updater is disabled and the UI tells the user which command to run.
 * - `unknown` → installed via a path we don't recognize (manual extract,
 *   custom packaging). Treated like a distro package: disable the updater
 *   and fall back to a generic message.
 */
export type LinuxInstallType = "appimage" | "deb" | "rpm" | "unknown";

export interface LinuxInstallInfo {
  type: LinuxInstallType;
  /**
   * User-facing instruction shown in the renderer when in-app updates are
   * suppressed. Empty for `appimage` because the updater handles it.
   */
  message: string;
}

const APPIMAGE_MESSAGE = "";

const DEB_MESSAGE =
  "Cadencr was installed via your package manager — run `sudo apt upgrade cadencr` to update.";

const RPM_MESSAGE =
  "Cadencr was installed via your package manager — run `sudo dnf upgrade cadencr` to update.";

const UNKNOWN_MESSAGE =
  "Cadencr was installed outside the in-app updater — use your package manager to upgrade.";

/**
 * Detect how the running Linux build was installed.
 *
 * `APPIMAGE` is set by the AppImage runtime itself, so that check is fully
 * deterministic. Distinguishing deb vs rpm requires reading `/etc/os-release`
 * — there's no env var the packager sets that we can rely on. The detection
 * is best-effort: if `/etc/os-release` is missing or unparseable we return
 * `unknown` rather than guessing.
 */
export function detectLinuxInstallType(
  env: NodeJS.ProcessEnv = process.env,
  osReleasePath = "/etc/os-release",
): LinuxInstallInfo {
  if (env.APPIMAGE) return { type: "appimage", message: APPIMAGE_MESSAGE };

  const family = readDistroFamily(osReleasePath);
  if (family === "debian") return { type: "deb", message: DEB_MESSAGE };
  if (family === "rhel" || family === "suse") return { type: "rpm", message: RPM_MESSAGE };
  return { type: "unknown", message: UNKNOWN_MESSAGE };
}

type DistroFamily = "debian" | "rhel" | "suse" | "unknown";

const FAMILY_TOKENS: ReadonlyArray<{ family: DistroFamily; tokens: RegExp }> = [
  { family: "debian", tokens: /(?:^|\s)(debian|ubuntu|mint|pop|elementary|kali|raspbian)(?:\s|$)/ },
  { family: "rhel", tokens: /(?:^|\s)(fedora|rhel|centos|rocky|almalinux|amzn|ol)(?:\s|$)/ },
  { family: "suse", tokens: /(?:^|\s)(suse|opensuse|sles)(?:\s|$)/ },
];

function readDistroFamily(osReleasePath: string): DistroFamily {
  let raw: string;
  try {
    raw = readFileSync(osReleasePath, "utf8");
  } catch {
    return "unknown";
  }
  const haystack = `${readKey(raw, "ID")} ${readKey(raw, "ID_LIKE")}`.toLowerCase();
  return FAMILY_TOKENS.find(({ tokens }) => tokens.test(haystack))?.family ?? "unknown";
}

function readKey(content: string, key: string): string {
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(content);
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

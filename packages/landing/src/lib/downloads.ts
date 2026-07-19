import landingPackage from "../../package.json";

type SupportedDownloadOs = "linux" | "macos";
export type DetectedOs = SupportedDownloadOs | "windows" | "unknown";
export type DetectedArch = "arm64" | "x64" | "unknown";
type DownloadKind = "installer" | "archive" | "portable";

interface DownloadAsset {
  assetName: string;
  arch: DetectedArch;
  href: string;
  kind: DownloadKind;
  label: string;
  os: SupportedDownloadOs;
  size: string;
  url: string;
}

interface DownloadDetection {
  arch: DetectedArch;
  os: DetectedOs;
}

const appVersion: string = landingPackage.version;
const releaseTag: string = `v${appVersion}`;
const releaseBaseUrl: string = `https://github.com/merkr-software/CadencR/releases/download/${releaseTag}`;

function releaseAssetUrl(assetName: string): string {
  return `${releaseBaseUrl}/${assetName}`;
}

export const LATEST_RELEASE_URL: string =
  "https://github.com/merkr-software/CadencR/releases/latest";
export const DISPLAY_VERSION: string = releaseTag;

export const DOWNLOAD_ASSETS: DownloadAsset[] = [
  {
    assetName: `Cadencr-${appVersion}-arm64.dmg`,
    arch: "arm64",
    href: "#macos-arm64-dmg",
    kind: "installer",
    label: "macOS Apple Silicon DMG",
    os: "macos",
    size: "146 MB",
    url: releaseAssetUrl(`Cadencr-${appVersion}-arm64.dmg`),
  },
  {
    assetName: `Cadencr-${appVersion}.dmg`,
    arch: "x64",
    href: "#macos-intel-dmg",
    kind: "installer",
    label: "macOS Intel DMG",
    os: "macos",
    size: "152 MB",
    url: releaseAssetUrl(`Cadencr-${appVersion}.dmg`),
  },
  {
    assetName: `Cadencr-${appVersion}-arm64-mac.zip`,
    arch: "arm64",
    href: "#macos-arm64-zip",
    kind: "archive",
    label: "macOS Apple Silicon ZIP",
    os: "macos",
    size: "140 MB",
    url: releaseAssetUrl(`Cadencr-${appVersion}-arm64-mac.zip`),
  },
  {
    assetName: `Cadencr-${appVersion}-mac.zip`,
    arch: "x64",
    href: "#macos-intel-zip",
    kind: "archive",
    label: "macOS Intel ZIP",
    os: "macos",
    size: "147 MB",
    url: releaseAssetUrl(`Cadencr-${appVersion}-mac.zip`),
  },
  {
    assetName: `Cadencr-${appVersion}.AppImage`,
    arch: "x64",
    href: "#linux-appimage",
    kind: "portable",
    label: "Linux x86-64 AppImage",
    os: "linux",
    size: "152 MB",
    url: releaseAssetUrl(`Cadencr-${appVersion}.AppImage`),
  },
  {
    assetName: `Cadencr-${appVersion}-amd64.deb`,
    arch: "x64",
    href: "#linux-deb",
    kind: "installer",
    label: "Linux x86-64 DEB",
    os: "linux",
    size: "122 MB",
    url: releaseAssetUrl(`Cadencr-${appVersion}-amd64.deb`),
  },
  {
    assetName: `Cadencr-${appVersion}-x86_64.rpm`,
    arch: "x64",
    href: "#linux-rpm",
    kind: "installer",
    label: "Linux x86-64 RPM",
    os: "linux",
    size: "122 MB",
    url: releaseAssetUrl(`Cadencr-${appVersion}-x86_64.rpm`),
  },
];

/**
 * The build we hand a macOS visitor for a given detected arch. Only a definitive
 * Intel signal picks x64; everything else — including "unknown" — defaults to
 * Apple Silicon: every Mac since late 2020 is arm64, and the browsers that can't
 * report arch (Safari, Firefox) skew even further that way. Handing an unknown
 * visitor the Intel DMG silently runs the whole app under Rosetta; arm64-on-Intel
 * instead fails loudly and is trivially corrected from the manual target list.
 *
 * Shared so the page's client-side `chooseDownload` can't drift from the SSR
 * default.
 */
export function preferredMacArch(arch: DetectedArch): DetectedArch {
  return arch === "x64" ? "x64" : "arm64";
}

export function selectRecommendedDownload(detection: DownloadDetection): DownloadAsset | undefined {
  if (detection.os === "linux") {
    if (detection.arch === "arm64") return undefined;
    return DOWNLOAD_ASSETS.find(
      (asset) => asset.os === "linux" && asset.assetName.endsWith(".AppImage"),
    );
  }
  if (detection.os !== "macos") return undefined;

  const wanted = preferredMacArch(detection.arch);
  return DOWNLOAD_ASSETS.find(
    (asset) => asset.os === "macos" && asset.arch === wanted && asset.assetName.endsWith(".dmg"),
  );
}

/** Normalize a raw architecture token (e.g. from `userAgentData`) to our enum. */
export function normalizeArch(value: string): DetectedArch {
  const arch = value.toLowerCase();
  if (arch.includes("arm") || arch.includes("aarch64")) return "arm64";
  if (arch.includes("x86") || arch.includes("x64") || arch.includes("intel")) return "x64";
  return "unknown";
}

/**
 * Infer arch from a WebGL GPU renderer string. This is the only architecture
 * signal Safari and Firefox expose: `navigator.userAgentData` is Chromium-only,
 * and Apple masks the CPU as "Intel" in the UA string on every Mac. Apple
 * Silicon reports an "Apple" GPU (e.g. "Apple M3", "ANGLE Metal Renderer:
 * Apple M3"); Intel Macs report Intel/AMD/Radeon.
 */
export function archFromRenderer(renderer: string): DetectedArch {
  const value = renderer.toLowerCase();
  if (value.includes("apple")) return "arm64";
  if (value.includes("intel") || value.includes("amd") || value.includes("radeon")) return "x64";
  return "unknown";
}

/**
 * Combine the available arch signals for a macOS visitor. The GPU renderer
 * reflects the physical machine and survives Rosetta (a Chromium process
 * translated to x86 still reports "Apple" via Metal), so it wins when
 * definitive; `userAgentData.architecture` is the Chromium fallback. A leftover
 * "unknown" is handed to `selectRecommendedDownload`, which defaults it to arm64.
 */
export function resolveMacArch(signals: {
  renderer: DetectedArch;
  userAgentData: DetectedArch;
}): DetectedArch {
  if (signals.renderer !== "unknown") return signals.renderer;
  return signals.userAgentData;
}

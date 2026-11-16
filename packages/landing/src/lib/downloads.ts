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
const RELEASES_DOWNLOAD_URL = "https://github.com/merkr-software/CadencR/releases/download";
const releaseBaseUrl: string = `${RELEASES_DOWNLOAD_URL}/${releaseTag}`;

function releaseAssetUrl(assetName: string): string {
  return `${releaseBaseUrl}/${assetName}`;
}

type MacArch = Exclude<DetectedArch, "unknown">;

/** Up to this release the Intel build shipped without an arch suffix. */
const LAST_UNSUFFIXED_INTEL_RELEASE = "0.13.0";

/** `version` is a parameter only so tests can cover both naming schemes. */
export function macReleaseAssetName(version: string, arch: MacArch, kind: DownloadKind): string {
  const archSuffix = arch === "x64" && version === LAST_UNSUFFIXED_INTEL_RELEASE ? "" : `-${arch}`;
  return `Cadencr-${version}${archSuffix}${kind === "installer" ? ".dmg" : "-mac.zip"}`;
}

function macAsset(
  arch: MacArch,
  kind: DownloadKind,
  display: Pick<DownloadAsset, "href" | "label" | "size">,
): DownloadAsset {
  const assetName = macReleaseAssetName(appVersion, arch, kind);
  return { ...display, assetName, arch, kind, os: "macos", url: releaseAssetUrl(assetName) };
}

/**
 * The desktop release carrying the Linux alpha packages, or `null` while none
 * does. desktop-linux-release.yml attaches them to a published release by hand,
 * so this can lag the macOS version: set it once that workflow has succeeded.
 */
export const LINUX_ALPHA_RELEASE: string | null = null;

/** `version` is a parameter only so tests can cover both states of the flag. */
export function linuxReleaseAssets(version: string | null): DownloadAsset[] {
  if (version === null) return [];
  const linuxAsset = (
    assetName: string,
    kind: DownloadKind,
    display: Pick<DownloadAsset, "href" | "label" | "size">,
  ): DownloadAsset => ({
    ...display,
    assetName,
    arch: "x64",
    kind,
    os: "linux",
    url: `${RELEASES_DOWNLOAD_URL}/v${version}/${assetName}`,
  });
  return [
    linuxAsset(`Cadencr-${version}-x86_64.AppImage`, "portable", {
      href: "#linux-appimage",
      label: "Linux x86-64 AppImage",
      size: "152 MB",
    }),
    linuxAsset(`Cadencr-${version}-amd64.deb`, "installer", {
      href: "#linux-deb",
      label: "Linux x86-64 DEB",
      size: "122 MB",
    }),
    linuxAsset(`Cadencr-${version}-x86_64.rpm`, "installer", {
      href: "#linux-rpm",
      label: "Linux x86-64 RPM",
      size: "122 MB",
    }),
  ];
}

export const LINUX_AVAILABLE: boolean = LINUX_ALPHA_RELEASE !== null;

export const LATEST_RELEASE_URL: string =
  "https://github.com/merkr-software/CadencR/releases/latest";
export const DISPLAY_VERSION: string = releaseTag;

export const DOWNLOAD_ASSETS: DownloadAsset[] = [
  macAsset("arm64", "installer", {
    href: "#macos-arm64-dmg",
    label: "macOS Apple Silicon DMG",
    size: "146 MB",
  }),
  macAsset("x64", "installer", {
    href: "#macos-intel-dmg",
    label: "macOS Intel DMG",
    size: "152 MB",
  }),
  macAsset("arm64", "archive", {
    href: "#macos-arm64-zip",
    label: "macOS Apple Silicon ZIP",
    size: "140 MB",
  }),
  macAsset("x64", "archive", {
    href: "#macos-intel-zip",
    label: "macOS Intel ZIP",
    size: "147 MB",
  }),
  ...linuxReleaseAssets(LINUX_ALPHA_RELEASE),
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

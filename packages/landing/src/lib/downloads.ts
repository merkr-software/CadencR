import landingPackage from "../../package.json";

type SupportedDownloadOs = "macos";
type DetectedOs = SupportedDownloadOs | "windows" | "linux" | "unknown";
type DetectedArch = "arm64" | "x64" | "unknown";
type DownloadKind = "installer" | "archive";

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
];

export function selectRecommendedDownload(detection: DownloadDetection): DownloadAsset | undefined {
  if (detection.os !== "macos") return undefined;

  if (detection.arch === "arm64") {
    return DOWNLOAD_ASSETS.find((asset) => asset.assetName.endsWith("-arm64.dmg"));
  }

  return DOWNLOAD_ASSETS.find((asset) => asset.assetName.endsWith(".dmg") && asset.arch === "x64");
}

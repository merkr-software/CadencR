import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { formatPercent } from "@/lib/format-number";
import { translateUi, uiI18n, type UiTranslator } from "@/lib/i18n/ui";
import type { UpdateSnapshot, UpdateStatus } from "@/shared/update-state";

type UpdateDetail = Pick<
  UpdateSnapshot,
  "progress" | "version" | "error" | "unsupportedMessage" | "unsupportedReason"
>;

export function formatUpdateProgress(progress: number, locale: string): string {
  return formatPercent(progress / 100, locale);
}

/** One line on where an update check stands (Settings → About, `cadencr update`). */
export function updateStatusMessage(
  status: UpdateStatus,
  detail: UpdateDetail,
  t: UiTranslator = translateUi,
  locale = formattingLocale(uiI18n.language),
): string {
  const { version } = detail;
  switch (status) {
    case "checking":
      return t("updates.checking", "Checking for updates…");
    case "downloading": {
      const progress = formatUpdateProgress(detail.progress, locale);
      return version
        ? t("updates.downloadingVersion", "Downloading update v{{version}}… {{progress}}", {
            version,
            progress,
          })
        : t("updates.downloading", "Downloading update… {{progress}}", { progress });
    }
    case "downloaded":
      return version
        ? t("updates.readyVersion", "Update v{{version}} ready. Restart to install.", { version })
        : t("updates.ready", "Update ready. Restart to install.");
    case "up-to-date":
      return t("updates.upToDate", "You're on the latest version.");
    case "available":
      return version
        ? t("updates.availableVersion", "Update v{{version}} available.", { version })
        : t("updates.available", "An update is available.");
    case "error":
      return detail.error
        ? t("updates.checkErrorDetail", "Update check failed: {{detail}}", { detail: detail.error })
        : t("updates.checkError", "Update check failed.");
    case "unsupported":
      if (detail.unsupportedMessage) return detail.unsupportedMessage;
      switch (detail.unsupportedReason) {
        case "unsupported-install":
          return t(
            "updates.unsupportedLinux",
            "This Linux build is not an official AppImage, DEB, or RPM package. Download an official build from GitHub Releases to enable in-app updates.",
          );
        case "dev-build":
          return t("updates.unsupportedDev", "Updates are disabled in dev builds.");
        default:
          return t(
            "updates.unsupportedInstall",
            "In-app updates are unavailable for this install.",
          );
      }
    case "idle":
      return "";
  }
}

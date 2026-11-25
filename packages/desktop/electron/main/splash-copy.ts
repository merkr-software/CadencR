import { translateUi as t } from "../../src/shared/ui-i18n";
import type { SidecarPhase } from "./sidecar";

export type SplashPhase = "starting" | SidecarPhase;

export function splashCopyForPhase(phase: SplashPhase): { title: string; detail: string } {
  switch (phase) {
    // The independent development service exposes no startup progress.
    case "waiting_for_service":
    case "starting":
      return {
        title: t("system.startup.starting.title", "Starting Cadencr"),
        detail: t("system.startup.starting.detail", "Preparing the workspace…"),
      };
    case "starting_service":
      return {
        title: t("system.startup.starting.title", "Starting Cadencr"),
        detail: t("system.startup.startingService.detail", "Bringing up the backend service…"),
      };
    case "backing_up":
      return {
        title: t("system.startup.backingUp.title", "Backing up your database"),
        detail: t("system.startup.backingUp.detail", "Saving a snapshot before applying updates."),
      };
    case "backup_failed":
      return {
        title: t("system.startup.backupFailed.title", "Couldn't back up your database"),
        detail: t(
          "system.startup.backupFailed.detail",
          "Updates were not applied, so your data is unchanged. This is usually low disk space — free some up and reopen Cadencr.",
        ),
      };
    case "migrating":
      return {
        title: t("system.startup.migrating.title", "Updating your database"),
        detail: t(
          "system.startup.migrating.detail",
          "Applying schema changes. This may take a moment.",
        ),
      };
    case "optimizing_storage":
      return {
        title: t("system.startup.optimizingStorage.title", "Optimizing conversation storage"),
        detail: t(
          "system.startup.optimizingStorage.detail",
          "Removing verified duplicate terminal output and moving pasted images out of the database. Conversations are preserved.",
        ),
      };
    case "compacting_database":
      return {
        title: t("system.startup.compactingDatabase.title", "Reclaiming database space"),
        detail: t(
          "system.startup.compactingDatabase.detail",
          "Safely compacting unused pages. Your conversations are preserved.",
        ),
      };
    case "importing_usage":
      return {
        title: t("system.startup.importingUsage.title", "Importing usage history"),
        detail: t(
          "system.startup.importingUsage.detail",
          "Reading the last 30 days of provider token usage. This only happens once.",
        ),
      };
    case "loading_app":
      return {
        title: t("system.startup.loadingApp.title", "Almost there"),
        detail: t("system.startup.loadingApp.detail", "Loading your workspace…"),
      };
  }
}

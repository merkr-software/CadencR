import { expect, it } from "vitest";
import { uiI18n } from "@/lib/i18n/ui";
import { INITIAL_UPDATE_SNAPSHOT, reduceUpdateSnapshot } from "@/shared/update-state";
import { formatUpdateProgress, updateStatusMessage } from "./update-status-message";

it("formats update progress using the current regional percent convention", () => {
  // French Canada separates a numeral and percent sign with a non-breaking space.
  expect(formatUpdateProgress(52.75, "en-US")).toBe("53%");
  expect(formatUpdateProgress(52.75, "fr-CA")).toBe("53\u00a0%");
});

it("can redisplay a persisted unsupported reason and keeps opaque updater errors intact", async () => {
  const unsupported = reduceUpdateSnapshot(INITIAL_UPDATE_SNAPSHOT, {
    kind: "unsupported",
    reason: "dev-build",
  });
  const error = reduceUpdateSnapshot(unsupported, {
    kind: "error",
    message: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
  });
  expect(updateStatusMessage(unsupported.status, unsupported)).toBe(
    "Updates are disabled in dev builds.",
  );
  uiI18n.addResourceBundle("fr", "ui", {
    updates: {
      unsupportedDev: "Mises à jour désactivées pour cette version.",
      checkErrorDetail: "Échec de la recherche : {{detail}}",
    },
  });
  try {
    await uiI18n.changeLanguage("fr-CA");
    expect(updateStatusMessage(unsupported.status, unsupported)).toBe(
      "Mises à jour désactivées pour cette version.",
    );
    expect(updateStatusMessage(error.status, error)).toBe(
      "Échec de la recherche : ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    );
  } finally {
    await uiI18n.changeLanguage("en");
    uiI18n.removeResourceBundle("fr", "ui");
  }
});

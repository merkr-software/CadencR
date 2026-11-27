import { isAxiosError } from "axios";
import { z } from "zod";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors";
import { translateUi } from "@/lib/i18n/ui";

const namingDetails = z.object({ details: z.object({ auto_name_reason: z.string() }) });

export function autoNameErrorMessage(error: unknown): string {
  const code = apiErrorCode(error);
  if (code === "DATABASE_ERROR") {
    return translateUi(
      "conversation.featureTopBar.autoRenameDatabaseError",
      "A database error prevented auto-renaming this conversation. Try again.",
    );
  }
  const details = namingDetails.safeParse(isAxiosError(error) ? error.response?.data : undefined);
  return (
    namingDetail(code, details.data?.details.auto_name_reason) ??
    apiErrorMessage(
      error,
      translateUi("conversation.featureTopBar.autoRenameFailed", "Auto-rename failed"),
    )
  );
}

export function autoNameWarningMessage(code: string, message: string, reason?: string): string {
  if (!reason) return message;
  const detail = namingDetail(code, reason);
  return detail === undefined
    ? message
    : translateUi(
        "conversation.autoName.warning",
        "Could not auto-name this conversation. {{detail}}",
        { detail },
      );
}

function namingDetail(code: string | null, reason?: string): string | undefined {
  switch (reason) {
    case "settings_selection":
      return settingError(
        code,
        translateUi(
          "conversation.autoName.selectionSetting",
          "the auto-naming provider, model or active profile",
        ),
      );
    case "settings_profile":
      return settingError(
        code,
        translateUi("conversation.autoName.profileSetting", "the active auto-naming profile"),
      );
    case "settings_prompt":
      return settingError(
        code,
        translateUi("conversation.autoName.promptSetting", "the auto-naming system prompt"),
      );
    case "profile_load_failed":
      return translateUi(
        "conversation.autoName.profileLoadFailed",
        "Could not load the auto-naming provider profile. Check its configuration and try again.",
      );
    case "profile_invalid":
      return translateUi(
        "conversation.autoName.profileInvalid",
        "The auto-naming provider profile is invalid. Check its configuration and try again.",
      );
    case "close_failed":
      return translateUi(
        "conversation.autoName.closeFailed",
        "The auto-naming provider did not close cleanly. Try again.",
      );
    case "close_timeout":
      return translateUi(
        "conversation.autoName.closeTimeout",
        "The auto-naming provider did not close in time. Try again.",
      );
    case "database_busy":
      return translateUi(
        "conversation.autoName.databaseBusy",
        "The database is busy. Try again in a moment.",
      );
    case "database_read_failed":
      return translateUi(
        "conversation.autoName.databaseReadFailed",
        "Cadencr could not read the conversation title. Try again.",
      );
    case "database_write_failed":
      return translateUi(
        "conversation.autoName.databaseWriteFailed",
        "Cadencr could not save the conversation title. Try again.",
      );
    case "conversation_missing":
      return translateUi(
        "conversation.autoName.conversationMissing",
        "The conversation no longer exists.",
      );
    case "retry_from_title_menu":
      return translateUi(
        "conversation.autoName.retryFromTitleMenu",
        "Try again from the conversation title menu.",
      );
    case "by_code":
    case undefined:
      return namingCodeDetail(code);
    default:
      return undefined;
  }
}

function settingError(code: string | null, setting: string): string {
  switch (code) {
    case "SETTINGS_READ_FAILED":
      return translateUi(
        "conversation.autoName.settingsReadFailed",
        "The settings for {{setting}} could not be read. Check them in workspace settings via Edit JSON.",
        { setting },
      );
    case "SETTINGS_INVALID":
      return translateUi(
        "conversation.autoName.settingsInvalid",
        "The settings for {{setting}} are invalid. Check them in workspace settings via Edit JSON.",
        { setting },
      );
    default:
      return translateUi(
        "conversation.autoName.settingsLoadFailed",
        "The settings for {{setting}} could not be loaded. Check them in workspace settings via Edit JSON.",
        { setting },
      );
  }
}

function namingCodeDetail(code: string | null): string | undefined {
  switch (code) {
    case "NO_MODEL_AVAILABLE":
      return translateUi(
        "conversation.autoName.noModelAvailable",
        "The auto-naming provider exposes no usable models. Check that its CLI is installed and authenticated, or select another provider.",
      );
    case "AUTO_NAME_CLI_NOT_FOUND":
      return translateUi(
        "conversation.autoName.cliNotFound",
        "The auto-naming provider's CLI could not be found. Check its installation and try again.",
      );
    case "AUTO_NAME_PROVIDER_UNAVAILABLE":
      return translateUi(
        "conversation.autoName.providerUnavailable",
        "The auto-naming provider is unavailable. Check the provider in workspace settings.",
      );
    case "AUTO_NAME_START_TIMEOUT":
      return translateUi(
        "conversation.autoName.startTimeout",
        "The auto-naming provider did not start in time. Check its installation and active profile, then try again.",
      );
    case "AUTO_NAME_SPAWN_FAILED":
      return translateUi(
        "conversation.autoName.spawnFailed",
        "Could not start the auto-naming provider. Check its installation and active profile, then try again.",
      );
    case "AUTO_NAME_PROVIDER_FAILED":
      return translateUi(
        "conversation.autoName.providerFailed",
        "The auto-naming provider failed while generating the title. Check its model and authentication, then try again.",
      );
    case "AUTO_NAME_STREAM_FAILED":
      return translateUi(
        "conversation.autoName.streamFailed",
        "The auto-naming provider's connection failed before the title was ready. Try again.",
      );
    case "AUTO_NAME_STREAM_CLOSED":
      return translateUi(
        "conversation.autoName.streamClosed",
        "The auto-naming provider closed the connection before confirming a title. Try again.",
      );
    case "AUTO_NAME_TIMEOUT":
      return translateUi(
        "conversation.autoName.timeout",
        "The auto-naming provider did not finish in time. Try again or choose a faster naming model.",
      );
    case "AUTO_NAME_EMPTY_RESPONSE":
      return translateUi(
        "conversation.autoName.emptyResponse",
        "The auto-naming provider returned an empty title. Try again or choose another naming model.",
      );
    default:
      return undefined;
  }
}

import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useGetGitVersion, type GitVersionResponse } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { SettingsRow } from "./SettingsRow";

/**
 * The Git the service runs, as it detected it at startup, and what that Git
 * is too old for — the first thing to check when a Git flow fails on Linux.
 */
export function GitVersionRow(): React.JSX.Element {
  const { t } = useUiTranslation();
  // Detected once per service start: no refetch can change the answer.
  const query = useGetGitVersion({ query: { staleTime: Infinity } });

  let value = "…";
  let description = t(
    "workspace.git.gitVersionRow.detectingTheInstalledGit",
    "Detecting the installed Git…",
  );
  if (query.isError) {
    value = t("workspace.git.gitVersionRow.unknown", "Unknown");
    description = t(
      "workspace.git.gitVersionRow.couldNotReadTheGitVersionError",
      "Could not read the Git version: {{error}}",
      {
        error: apiErrorMessage(
          query.error,
          t("workspace.git.gitVersionRow.unknownError", "unknown error"),
        ),
      },
    );
  } else if (query.data) {
    ({ value, description } = describe(query.data, t));
  }

  return (
    <SettingsRow
      divided
      align="start"
      label={t("workspace.git.gitVersionRow.git", "Git")}
      description={description}
      control={<span className="font-mono text-xs text-muted-foreground">{value}</span>}
    />
  );
}

function describe(
  response: GitVersionResponse,
  t: UiTranslator,
): { value: string; description: string } {
  if (!response.version) {
    return {
      value: t("workspace.git.gitVersionRow.notFound", "Not found"),
      description: t(
        "workspace.git.gitVersionRow.gitIsRequiredForEveryGitFeature",
        "Git is required for every Git feature. {{error}}",
        { error: response.error ?? "" },
      ).trim(),
    };
  }
  if (response.unsupported.length === 0) {
    return {
      value: response.version,
      description: t(
        "workspace.git.gitVersionRow.everyGitFeatureIsAvailable",
        "Every Git feature is available.",
      ),
    };
  }
  const missing = response.unsupported
    .map((feature) => `${feature.label} (Git ${feature.minimum_version})`)
    .join(", ");
  return {
    value: response.version,
    description: t(
      "workspace.git.gitVersionRow.tooOldForCapabilitiesUpdateGitTo",
      "Too old for: {{capabilities}}. Update Git to use them.",
      { capabilities: missing },
    ),
  };
}

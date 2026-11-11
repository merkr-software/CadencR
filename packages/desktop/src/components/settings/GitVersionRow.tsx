import { useGetGitVersion, type GitVersionResponse } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { SettingsRow } from "./SettingsRow";

/**
 * The Git the service runs, as it detected it at startup, and what that Git
 * is too old for — the first thing to check when a Git flow fails on Linux.
 */
export function GitVersionRow(): React.JSX.Element {
  // Detected once per service start: no refetch can change the answer.
  const query = useGetGitVersion({ query: { staleTime: Infinity } });

  let value = "…";
  let description = "Detecting the installed Git…";
  if (query.isError) {
    value = "Unknown";
    description = `Could not read the Git version: ${apiErrorMessage(query.error, "unknown error")}`;
  } else if (query.data) {
    ({ value, description } = describe(query.data));
  }

  return (
    <SettingsRow
      divided
      align="start"
      label="Git"
      description={description}
      control={<span className="font-mono text-xs text-muted-foreground">{value}</span>}
    />
  );
}

function describe(response: GitVersionResponse): { value: string; description: string } {
  if (!response.version) {
    return {
      value: "Not found",
      description: `Git is required for every Git feature. ${response.error ?? ""}`.trim(),
    };
  }
  if (response.unsupported.length === 0) {
    return { value: response.version, description: "Every Git feature is available." };
  }
  const missing = response.unsupported
    .map((feature) => `${feature.label} (Git ${feature.minimum_version})`)
    .join(", ");
  return {
    value: response.version,
    description: `Too old for: ${missing}. Update Git to use them.`,
  };
}

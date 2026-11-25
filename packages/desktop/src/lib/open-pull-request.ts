import { translateUi } from "@/lib/i18n/ui";
import type { PrSummary } from "@/api/generated";
import { openExternalUrl } from "@/lib/open-external";

/**
 * The host's own noun for a proposal, mid-sentence: "pull request" on
 * GitHub/Bitbucket, "merge request" on GitLab. The backend ships `pr_label`
 * capitalized for headings, so every in-sentence use goes through here.
 */
export function prNoun(pr: PrSummary): string {
  return pr.pr_label.toLowerCase();
}

/**
 * Open a pull request / merge request on its host in the default browser.
 * Shared by the Git tab's PR pane and the sidebar context menu so the failure
 * toast reads identically wherever the action lives.
 */
export async function openPullRequestExternally(pr: PrSummary): Promise<void> {
  const request = prNoun(pr);
  const error =
    request === "pull request"
      ? translateUi("project.pullRequest.openFailed", "Could not open this pull request.")
      : request === "merge request"
        ? translateUi("project.mergeRequest.openFailed", "Could not open this merge request.")
        : translateUi("project.request.openFailed", "Could not open this {{request}}.", {
            request,
          });
  await openExternalUrl(pr.url, error);
}

/** "Open pull request" / "Open merge request" — the host's own vocabulary. */
export function openPullRequestActionLabel(pr: PrSummary): string {
  return `Open ${prNoun(pr)}`;
}

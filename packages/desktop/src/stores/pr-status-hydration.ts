import { translateUi } from "@/lib/i18n/ui";
import { toast } from "sonner";
import { getGetPrCommentsQueryKey, getPrStatuses } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { queryClient } from "@/lib/queryClient";
import { usePrStatusStore } from "@/stores/usePrStatusStore";

export async function hydratePrStatuses(): Promise<void> {
  try {
    const snapshots = await getPrStatuses();
    usePrStatusStore.getState().hydrate(snapshots);
  } catch (error) {
    toast.error(
      translateUi(
        "workspace.git.prStatusHydration.couldNotLoadPullRequestStatus",
        "Could not load pull request status.",
      ),
      {
        description: apiErrorMessage(
          error,
          translateUi(
            "workspace.git.prStatusHydration.forgeStatusRequestFailed",
            "Forge status request failed",
          ),
        ),
      },
    );
  }
}

export async function refreshPrStatusesAfterAuth(): Promise<void> {
  try {
    await Promise.all([
      hydratePrStatuses(),
      queryClient.invalidateQueries({ queryKey: getGetPrCommentsQueryKey() }),
    ]);
  } catch (error) {
    toast.error(
      translateUi(
        "workspace.git.prStatusHydration.connectedButPullRequestViewsCouldNot",
        "Connected, but pull request views could not refresh.",
      ),
      {
        description: apiErrorMessage(
          error,
          translateUi(
            "workspace.git.prStatusHydration.forgeQueryInvalidationFailed",
            "Forge query invalidation failed",
          ),
        ),
      },
    );
  }
}

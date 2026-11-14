import { toast } from "sonner";
import { updateStatusMessage } from "@/lib/update-status-message";
import { useUpdateStore } from "@/stores/update-store";

type UpdateSnapshot = ReturnType<typeof useUpdateStore.getState>;

/**
 * How long the toast follows a check whose outcome has not arrived yet: the
 * outcome is an updater event, which can trail the check call.
 */
const FOLLOW_TIMEOUT_MS = 30_000;

/** Shows how a check ended; `false` while it is still running. */
function settle(state: UpdateSnapshot, toastId: string | number): boolean {
  const detail = {
    progress: state.progress,
    version: state.version,
    error: state.error,
    unsupportedMessage: state.unsupportedMessage,
  };
  const message = updateStatusMessage(state.status, detail);
  switch (state.status) {
    case "idle":
    case "checking":
      return false;
    case "available":
    case "downloading":
      // The download runs on; its banner offers the restart when it is ready.
      toast.success(updateStatusMessage("available", detail), {
        id: toastId,
        description: "Downloading it now. Cadencr offers to restart once it is ready.",
      });
      return true;
    case "up-to-date":
    case "downloaded":
      toast.success(message, { id: toastId });
      return true;
    case "error":
      toast.error(message, { id: toastId });
      return true;
    case "unsupported":
      toast.info(message, { id: toastId });
      return true;
  }
}

/**
 * `cadencr update`: runs the "Check for updates" button's check and keeps one
 * toast on it until it ends, so the result shows where the request landed
 * rather than only in Settings → About. Resolves once the check call returns,
 * so the next `cadencr` request does not wait on the outcome.
 */
export async function followUpdateCheck(): Promise<void> {
  const toastId = toast.loading("Checking for updates…");
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: () => void = () => {};
  const finish = (state: UpdateSnapshot): void => {
    if (done || !settle(state, toastId)) return;
    done = true;
    unsubscribe();
    clearTimeout(timer);
  };
  unsubscribe = useUpdateStore.subscribe(finish);
  await useUpdateStore.getState().checkForUpdates();
  // The store may have settled before the subscription fired.
  finish(useUpdateStore.getState());
  if (done) return;
  timer = setTimeout(() => {
    done = true;
    unsubscribe();
    toast.info("Still checking for updates. Settings → About shows the result.", {
      id: toastId,
    });
  }, FOLLOW_TIMEOUT_MS);
}

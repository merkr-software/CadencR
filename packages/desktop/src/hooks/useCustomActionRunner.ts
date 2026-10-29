import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { resolveCommand, useRunCustomAction, type CustomAction } from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { invalidateCustomActionRunQueries } from "@/lib/custom-action-queries";
import { useTerminalStore } from "@/hooks/useTerminalState";

interface UseCustomActionRunnerArgs {
  action: CustomAction;
  featureId: number;
  projectId: number;
}

interface CustomActionRunner {
  /** Kick off the action — backgrounded server run, or a terminal split when `run_in_terminal`. */
  run: () => void;
  /** True while the run is being started (mutation pending, or resolving the terminal command). */
  isStarting: boolean;
}

/**
 * Single entry point for running a custom action, shared by the header button
 * and the details surface. When the action opts into `run_in_terminal`, the
 * resolved command is spawned in a dedicated terminal split (a client-side PTY)
 * instead of a backgrounded server process — so a long-running, interactive
 * command (e.g. a dev server) is owned by the terminal, with its own
 * kill/restart controls, rather than a hidden background run.
 */
export function useCustomActionRunner({
  action,
  featureId,
  projectId,
}: UseCustomActionRunnerArgs): CustomActionRunner {
  const queryClient = useQueryClient();
  const [isResolving, setIsResolving] = useState(false);

  const runMutation = useRunCustomAction({
    mutation: {
      // The run is asynchronous: success just means it started. Refresh the run
      // queries so the status flips to "running"; the poll keeps it live.
      onSuccess: () => {
        invalidateCustomActionRunQueries({
          queryClient,
          projectId,
          actionId: action.id,
          featureId,
        });
      },
      onError: (err) =>
        toast.error(`${action.name} failed: ${apiErrorMessage(err, "the run could not start")}`),
    },
  });

  // Depend on the stable `mutate` reference (not the whole `runMutation`, which
  // react-query recreates each render) so `run` stays referentially stable.
  const runBackground = runMutation.mutate;
  const run = useCallback(() => {
    if (action.run_in_terminal) {
      // Resolve the ${VAR}-interpolated command server-side (same logic a
      // background run uses), then hand it to the terminal split. The pane
      // already opens in the feature's working directory.
      setIsResolving(true);
      resolveCommand(action.id, { feature_id: featureId })
        .then(({ command }) => {
          // initialCommand is written verbatim to the PTY, so append a newline
          // to execute it instead of just typing it.
          useTerminalStore.getState().sendToTerminal(featureId, `${command}\n`);
        })
        .catch((err: unknown) => {
          const message = apiErrorMessage(err, String(err));
          toast.error(`${action.name} failed: ${message}`);
        })
        .finally(() => setIsResolving(false));
      return;
    }
    runBackground({ id: action.id, params: { feature_id: featureId } });
  }, [action.id, action.name, action.run_in_terminal, featureId, runBackground]);

  const isStarting = runMutation.isPending || isResolving;
  return useMemo(() => ({ run, isStarting }), [run, isStarting]);
}

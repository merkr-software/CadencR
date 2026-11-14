import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  CLI_INSTALL_STATUS_QUERY_KEY,
  cliPathHint,
  describeCliInstall,
  reportCliInstalled,
} from "@/lib/cli/cli-install";
import { desktopBridge } from "@/lib/desktop-bridge";
import type { CliInstallStatus } from "@/shared/cli-bridge";
import { SettingsRow } from "./SettingsRow";

type Action = "install" | "replace" | "uninstall";

function useCliInstall() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: CLI_INSTALL_STATUS_QUERY_KEY,
    queryFn: () => desktopBridge.cliInstallStatus(),
  });
  const mutation = useMutation({
    mutationFn: (action: Action): Promise<CliInstallStatus> =>
      action === "uninstall"
        ? desktopBridge.uninstallCli()
        : desktopBridge.installCli({ replace: action === "replace" }),
    onSuccess: (next, action) => {
      if (action !== "uninstall") {
        reportCliInstalled(queryClient, next);
        return;
      }
      queryClient.setQueryData(CLI_INSTALL_STATUS_QUERY_KEY, next);
      toast.success("Removed the cadencr command");
    },
    onError: (error) => {
      toast.error(apiErrorMessage(error, "Couldn't change the cadencr command"));
    },
  });
  return { status, mutation };
}

function CommandLineControls({
  status,
  pending,
  run,
  confirmReplace,
}: {
  status: CliInstallStatus;
  pending: Action | null;
  run: (action: Action) => void;
  confirmReplace: () => void;
}): React.JSX.Element | null {
  const busy = pending !== null;
  const spinner = (action: Action) =>
    pending === action ? <Loader2Icon className="size-4 animate-spin" aria-hidden /> : null;
  switch (status.state) {
    case "unavailable":
    case "package":
      return null;
    case "not-installed":
      return (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run("install")}>
          {spinner("install")}
          Install
        </Button>
      );
    case "conflict":
      return (
        <Button size="sm" variant="outline" disabled={busy} onClick={confirmReplace}>
          {spinner("replace")}
          Replace…
        </Button>
      );
    case "installed":
      return (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run("install")}>
            {spinner("install")}
            Reinstall
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run("uninstall")}>
            {spinner("uninstall")}
            Uninstall
          </Button>
        </div>
      );
  }
}

/** Settings → General: puts the `cadencr` command on PATH, like an editor's shell command. */
export function CommandLineRow(): React.JSX.Element {
  const { status, mutation } = useCliInstall();
  const [confirming, setConfirming] = useState(false);
  const pending = mutation.isPending ? mutation.variables : null;
  let description: React.ReactNode = "Checking the cadencr command…";
  if (status.isError) {
    description = `Couldn't check the cadencr command: ${apiErrorMessage(status.error, "unknown error")}`;
  } else if (status.data) {
    const hint = cliPathHint(status.data);
    description = (
      <>
        {describeCliInstall(status.data)}
        {hint ? <span className="mt-1 block text-[var(--acc-yellow)]">{hint}</span> : null}
      </>
    );
  }
  return (
    <>
      <SettingsRow
        align="start"
        label={<code className="font-mono">cadencr</code>}
        description={description}
        control={
          status.data ? (
            <CommandLineControls
              status={status.data}
              pending={pending ?? null}
              run={(action) => mutation.mutate(action)}
              confirmReplace={() => setConfirming(true)}
            />
          ) : null
        }
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Replace the existing cadencr?"
        description={
          status.data?.state === "conflict"
            ? `${status.data.target} is ${status.data.existing}. Cadencr will put its own command there instead.`
            : undefined
        }
        confirmText="Replace"
        variant="destructive"
        onConfirm={() => mutation.mutate("replace")}
      />
    </>
  );
}

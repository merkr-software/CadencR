import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
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
  describeCliConflict,
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
      toast.success(
        translateUi("settings.general.commandLine.removed", "Removed the cadencr command"),
      );
    },
    onError: (error) => {
      toast.error(
        apiErrorMessage(
          error,
          translateUi(
            "settings.general.commandLine.changeError",
            "Couldn't change the cadencr command",
          ),
        ),
      );
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
  const { t } = useUiTranslation();
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
          {t("settings.general.commandLine.install", "Install")}
        </Button>
      );
    case "conflict":
      return (
        <Button size="sm" variant="outline" disabled={busy} onClick={confirmReplace}>
          {spinner("replace")}
          {t("settings.general.commandLine.replaceAction", "Replace…")}
        </Button>
      );
    case "installed":
      return (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run("install")}>
            {spinner("install")}
            {t("settings.general.commandLine.reinstall", "Reinstall")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run("uninstall")}>
            {spinner("uninstall")}
            {t("settings.general.commandLine.uninstall", "Uninstall")}
          </Button>
        </div>
      );
  }
}

/** Settings → General: puts the `cadencr` command on PATH, like an editor's shell command. */
export function CommandLineRow(): React.JSX.Element {
  const { t } = useUiTranslation();
  const { status, mutation } = useCliInstall();
  const [confirming, setConfirming] = useState(false);
  const pending = mutation.isPending ? mutation.variables : null;
  let description: React.ReactNode = t(
    "settings.general.commandLine.checking",
    "Checking the cadencr command…",
  );
  if (status.isError) {
    description = t(
      "settings.general.commandLine.checkError",
      "Couldn't check the cadencr command: {{error}}",
      {
        error: apiErrorMessage(
          status.error,
          t("settings.general.commandLine.unknownError", "unknown error"),
        ),
      },
    );
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
        title={t("settings.general.commandLine.replaceTitle", "Replace the existing cadencr?")}
        description={
          status.data?.state === "conflict"
            ? t(
                "settings.general.commandLine.replaceDescription",
                "{{target}} is {{existing}}. Cadencr will put its own command there instead.",
                { target: status.data.target, existing: describeCliConflict(status.data) },
              )
            : undefined
        }
        confirmText={t("settings.general.commandLine.replace", "Replace")}
        variant="destructive"
        onConfirm={() => mutation.mutate("replace")}
      />
    </>
  );
}

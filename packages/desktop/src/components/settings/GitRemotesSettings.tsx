import { forgeKindCapabilities } from "./forge-kind-capabilities";
import { ForgeHostControls, ForgeHostActions } from "./ForgeHostControls";
import { useUiTranslation, translateUi, type UiTranslator } from "@/lib/i18n/ui";
import { useEffect, useState, type ReactElement } from "react";
import { CheckCircle2Icon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import {
  GitHost,
  getGetForgeAuthStatusQueryKey,
  useDeleteForgeToken,
  useGetForgeAuthStatus,
  usePutForgeToken,
  type ForgeAuthStatus,
  type ForgeAuthStatusSource,
  type ForgeTokenRequest,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { apiErrorMessage } from "@/lib/api-errors";
import { queryClient } from "@/lib/queryClient";
import { FORGE_SETTINGS_ANCHOR } from "@/lib/settings-anchors";
import { refreshPrStatusesAfterAuth } from "@/stores/pr-status-hydration";

/**
 * Remote-host connections inside the Git settings section. Connecting a host
 * is what turns on pull request / merge request status, checks, and comments —
 * it isn't a separate concern from Git, so it renders as a group under "Git"
 * rather than a top-level section of its own.
 */
export function GitRemotesSettings(): ReactElement {
  const { t } = useUiTranslation();
  const statusQuery = useGetForgeAuthStatus({ query: { retry: false } });
  const { busy, pendingHost, save, disconnect } = useForgeTokenActions();

  return (
    // The PR pane's "Connect a provider" button deep-links straight to this group.
    <SettingsGroup
      id={FORGE_SETTINGS_ANCHOR}
      bare
      title={t("workspace.git.gitRemotesSettings.remoteConnections", "Remote connections")}
      description={t(
        "workspace.git.gitRemotesSettings.connectTheHostBehindEachProjectSOrigin",
        "Connect the host behind each project's origin remote to see pull request and merge request status, checks and comments. Tokens stay on this machine in an owner-only secret file, never in workspace settings.",
      )}
    >
      <div className="space-y-3">
        <RemoteConnectionsNotice
          isLoading={statusQuery.isLoading}
          error={statusQuery.isError ? statusQuery.error : null}
          isEmpty={statusQuery.data?.length === 0}
        />
        {statusQuery.data?.map((status) => (
          <ForgeHostCard
            key={status.hostname}
            status={status}
            pending={busy && pendingHost === status.hostname}
            disabled={busy}
            onSave={save}
            onDisconnect={disconnect}
          />
        ))}
      </div>
    </SettingsGroup>
  );
}

/** Loading, failure and "no remotes" states above the host cards. */
function RemoteConnectionsNotice({
  isLoading,
  error,
  isEmpty,
}: {
  isLoading: boolean;
  error: unknown;
  isEmpty: boolean;
}): React.JSX.Element | null {
  const { t } = useUiTranslation();
  if (isLoading) {
    return (
      <SettingsCard padded>
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2Icon className="size-4 animate-spin" aria-hidden />{" "}
          {t(
            "workspace.git.gitRemotesSettings.detectingProjectRemotes",
            "Detecting project remotes…",
          )}
        </p>
      </SettingsCard>
    );
  }
  if (error) {
    return (
      <SettingsCard padded tone="danger">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-destructive">
            {apiErrorMessage(
              error,
              translateUi(
                "workspace.git.gitRemotesSettings.couldNotLoadRemoteConnections",
                "Could not load remote connections",
              ),
            )}
          </p>
          <Button variant="outline" size="sm" onClick={refreshForgeAuthStatus}>
            <RefreshCwIcon className="mr-1.5 size-3.5" aria-hidden />{" "}
            {t("workspace.git.gitRemotesSettings.retry", "Retry")}
          </Button>
        </div>
      </SettingsCard>
    );
  }
  if (isEmpty) {
    return (
      <SettingsCard padded>
        <p className="text-sm text-muted-foreground">
          {t(
            "workspace.git.gitRemotesSettings.noGitRemotesWereDetectedInThe",
            "No Git remotes were detected in the current projects.",
          )}
        </p>
      </SettingsCard>
    );
  }
  return null;
}

function refreshForgeAuthStatus(): void {
  void queryClient.invalidateQueries({ queryKey: getGetForgeAuthStatusQueryKey() });
}

function forgeConnectionDescription(
  username: string,
  source: ForgeAuthStatusSource | undefined,
  t: UiTranslator,
): string {
  switch (source) {
    case "stored":
      return t(
        "workspace.git.gitRemotesSettings.connectedAsWithStoredToken",
        "Connected as {{username}} via a stored token",
        { username },
      );
    case "cli":
      return t(
        "workspace.git.gitRemotesSettings.connectedAsWithCli",
        "Connected as {{username}} via the CLI",
        { username },
      );
    default:
      return t(
        "workspace.git.gitRemotesSettings.connectedAsWithToken",
        "Connected as {{username}} via a token",
        { username },
      );
  }
}

function ForgeHostCard({
  status,
  pending,
  disabled,
  onSave,
  onDisconnect,
}: {
  status: ForgeAuthStatus;
  pending: boolean;
  disabled: boolean;
  onSave: (request: ForgeTokenRequest) => void;
  onDisconnect: (hostname: string) => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const [kind, setKind] = useState(status.kind);
  const [apiBaseUrl, setApiBaseUrl] = useState(status.api_base_url ?? "");
  const [username, setUsername] = useState(status.username ?? "");
  const [token, setToken] = useState("");
  const [useCliAuth, setUseCliAuth] = useState(status.use_cli_auth);

  useEffect(() => {
    setKind(status.kind);
    setApiBaseUrl(status.api_base_url ?? "");
    setUsername(status.username ?? "");
    setToken("");
    setUseCliAuth(status.use_cli_auth);
  }, [status]);

  const handleSave = (): void => {
    const cliAuthAvailable = forgeKindCapabilities(kind).cliAuthAvailable;
    onSave({
      hostname: status.hostname,
      kind,
      api_base_url: apiBaseUrl.trim() || undefined,
      username: username.trim() || undefined,
      token: token.trim() || undefined,
      use_cli_auth: cliAuthAvailable && useCliAuth,
    });
  };
  const handleKindChange = (value: GitHost): void => {
    setKind(value);
    if (!forgeKindCapabilities(value).cliAuthAvailable) {
      setUseCliAuth(false);
    }
  };

  return (
    <SettingsCard
      padded
      title={status.hostname}
      description={
        status.validated_user
          ? forgeConnectionDescription(status.validated_user.username, status.source, t)
          : t(
              "workspace.git.gitRemotesSettings.connectToDetectPullRequestsAndMerge",
              "Connect to detect pull requests and merge requests on this host.",
            )
      }
      action={
        status.validated_user ? (
          <span className="inline-flex items-center gap-1 text-xs text-[var(--acc-green)]">
            <CheckCircle2Icon className="size-3.5" aria-hidden />{" "}
            {t("workspace.git.gitRemotesSettings.connected", "Connected")}
          </span>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {status.error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {status.error}
          </p>
        )}
        <ForgeHostControls
          status={status}
          disabled={disabled}
          kind={kind}
          apiBaseUrl={apiBaseUrl}
          username={username}
          token={token}
          useCliAuth={useCliAuth}
          onKindChange={handleKindChange}
          onApiBaseUrlChange={setApiBaseUrl}
          onUsernameChange={setUsername}
          onTokenChange={setToken}
          onUseCliAuthChange={setUseCliAuth}
        />
        <ForgeHostActions
          status={status}
          pending={pending}
          disabled={disabled}
          onSave={handleSave}
          onDisconnect={onDisconnect}
        />
      </div>
    </SettingsCard>
  );
}

function useForgeTokenActions() {
  const saveToken = usePutForgeToken();
  const deleteToken = useDeleteForgeToken();
  const [pendingHost, setPendingHost] = useState<string | null>(null);
  const busy = saveToken.isPending || deleteToken.isPending;

  const save = (request: ForgeTokenRequest): void => {
    setPendingHost(request.hostname);
    saveToken.mutate(
      { data: request },
      {
        onSuccess: async (status) => {
          await refreshPrStatusesAfterAuth();
          showConnectionResult(status);
          refreshForgeAuthStatus();
        },
        onError: (error) => {
          toast.error(
            translateUi(
              "workspace.git.gitRemotesSettings.couldNotConnectHostname",
              "Could not connect {{hostname}}",
              { hostname: request.hostname },
            ),
            {
              description: apiErrorMessage(
                error,
                translateUi(
                  "workspace.git.gitRemotesSettings.tokenValidationFailed",
                  "Token validation failed",
                ),
              ),
            },
          );
        },
        onSettled: () => setPendingHost(null),
      },
    );
  };
  const disconnect = (hostname: string): void => {
    setPendingHost(hostname);
    deleteToken.mutate(
      { params: { hostname } },
      {
        onSuccess: () => {
          toast.success(
            translateUi(
              "workspace.git.gitRemotesSettings.disconnectedHostname",
              "Disconnected {{hostname}}",
              { hostname: hostname },
            ),
          );
          refreshForgeAuthStatus();
        },
        onError: (error) => {
          toast.error(
            translateUi(
              "workspace.git.gitRemotesSettings.couldNotDisconnectHostname",
              "Could not disconnect {{hostname}}",
              { hostname: hostname },
            ),
            {
              description: apiErrorMessage(
                error,
                translateUi(
                  "workspace.git.gitRemotesSettings.tokenRemovalFailed",
                  "Token removal failed",
                ),
              ),
            },
          );
        },
        onSettled: () => setPendingHost(null),
      },
    );
  };

  return { busy, pendingHost, save, disconnect };
}

function showConnectionResult(status: ForgeAuthStatus): void {
  const showToast = status.error ? toast.warning : toast.success;
  const username = status.validated_user?.username;
  const description = username
    ? status.error
      ? translateUi(
          "workspace.git.gitRemotesSettings.signedInWithError",
          "Signed in as {{username}}. {{error}}",
          { username, error: status.error },
        )
      : translateUi("workspace.git.gitRemotesSettings.signedIn", "Signed in as {{username}}", {
          username,
        })
    : status.error;
  showToast(
    translateUi("workspace.git.gitRemotesSettings.connectedHostname", "Connected {{hostname}}", {
      hostname: status.hostname,
    }),
    { description },
  );
}

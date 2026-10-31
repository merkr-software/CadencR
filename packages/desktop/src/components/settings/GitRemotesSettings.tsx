import { useEffect, useState, type ReactElement } from "react";
import { CheckCircle2Icon, Loader2Icon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  GitHost,
  getGetForgeAuthStatusQueryKey,
  useDeleteForgeToken,
  useGetForgeAuthStatus,
  usePutForgeToken,
  type ForgeAuthStatus,
  type ForgeTokenRequest,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LabeledControl } from "@/components/settings/LabeledControl";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { apiErrorMessage } from "@/lib/api-errors";
import { queryClient } from "@/lib/queryClient";
import { FORGE_SETTINGS_ANCHOR } from "@/lib/settings-anchors";
import { refreshPrStatusesAfterAuth } from "@/stores/pr-status-hydration";
import { forgeKindCapabilities } from "./forge-kind-capabilities";

/**
 * Remote-host connections inside the Git settings section. Connecting a host
 * is what turns on pull request / merge request status, checks, and comments —
 * it isn't a separate concern from Git, so it renders as a group under "Git"
 * rather than a top-level section of its own.
 */
export function GitRemotesSettings(): ReactElement {
  const statusQuery = useGetForgeAuthStatus({ query: { retry: false } });
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
          const showToast = status.error ? toast.warning : toast.success;
          showToast(`Connected ${status.hostname}`, {
            description: status.validated_user
              ? status.error
                ? `Signed in as ${status.validated_user.username}. ${status.error}`
                : `Signed in as ${status.validated_user.username}`
              : status.error,
          });
          refreshForgeAuthStatus();
        },
        onError: (error) => {
          toast.error(`Could not connect ${request.hostname}`, {
            description: apiErrorMessage(error, "Token validation failed"),
          });
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
          toast.success(`Disconnected ${hostname}`);
          refreshForgeAuthStatus();
        },
        onError: (error) => {
          toast.error(`Could not disconnect ${hostname}`, {
            description: apiErrorMessage(error, "Token removal failed"),
          });
        },
        onSettled: () => setPendingHost(null),
      },
    );
  };

  return (
    // The PR pane's "Connect a provider" button deep-links straight to this group.
    <SettingsGroup
      id={FORGE_SETTINGS_ANCHOR}
      bare
      title="Remote connections"
      description="Connect the host behind each project's origin remote to see pull request and merge request status, checks and comments. Tokens stay on this machine in an owner-only secret file, never in workspace settings."
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
  if (isLoading) {
    return (
      <SettingsCard padded>
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2Icon className="size-4 animate-spin" aria-hidden /> Detecting project remotes…
        </p>
      </SettingsCard>
    );
  }
  if (error) {
    return (
      <SettingsCard padded tone="danger">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-destructive">
            {apiErrorMessage(error, "Could not load remote connections")}
          </p>
          <Button variant="outline" size="sm" onClick={refreshForgeAuthStatus}>
            <RefreshCwIcon className="mr-1.5 size-3.5" aria-hidden /> Retry
          </Button>
        </div>
      </SettingsCard>
    );
  }
  if (isEmpty) {
    return (
      <SettingsCard padded>
        <p className="text-sm text-muted-foreground">
          No Git remotes were detected in the current projects.
        </p>
      </SettingsCard>
    );
  }
  return null;
}

function refreshForgeAuthStatus(): void {
  void queryClient.invalidateQueries({ queryKey: getGetForgeAuthStatusQueryKey() });
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
          ? `Connected as ${status.validated_user.username} via ${status.source ?? "token"}`
          : "Connect to detect pull requests and merge requests on this host."
      }
      action={
        status.validated_user ? (
          <span className="inline-flex items-center gap-1 text-xs text-[var(--acc-green)]">
            <CheckCircle2Icon className="size-3.5" aria-hidden /> Connected
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

interface ForgeHostControlsProps {
  status: ForgeAuthStatus;
  disabled: boolean;
  kind: GitHost;
  apiBaseUrl: string;
  username: string;
  token: string;
  useCliAuth: boolean;
  onKindChange: (value: GitHost) => void;
  onApiBaseUrlChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onUseCliAuthChange: (value: boolean) => void;
}

function ForgeHostControls({
  status,
  disabled,
  kind,
  apiBaseUrl,
  username,
  token,
  useCliAuth,
  onKindChange,
  onApiBaseUrlChange,
  onUsernameChange,
  onTokenChange,
  onUseCliAuthChange,
}: ForgeHostControlsProps): ReactElement {
  const capabilities = forgeKindCapabilities(kind);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <LabeledControl label="Provider">
          <Select
            value={kind}
            onValueChange={(value) => onKindChange(value as GitHost)}
            disabled={disabled}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(GitHost).map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </LabeledControl>
        <LabeledControl label="API base URL" hint="Required for custom self-hosted domains.">
          <Input
            value={apiBaseUrl}
            onChange={(event) => onApiBaseUrlChange(event.target.value)}
            placeholder="https://git.example.com/api/…"
            disabled={disabled}
          />
        </LabeledControl>
      </div>
      {capabilities.usernameRequired && (
        <LabeledControl label="Atlassian account email">
          <Input
            value={username}
            onChange={(event) => onUsernameChange(event.target.value)}
            autoComplete="username"
            disabled={disabled}
          />
        </LabeledControl>
      )}
      <LabeledControl
        label="API token"
        hint={status.token_present ? "Leave blank to keep the stored token." : undefined}
      >
        <Input
          type="password"
          value={token}
          onChange={(event) => onTokenChange(event.target.value)}
          autoComplete="new-password"
          placeholder={status.token_present ? "Stored securely" : "Paste a read-only API token"}
          disabled={disabled || useCliAuth}
        />
      </LabeledControl>
      {capabilities.cliAuthAvailable && (
        <label className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
          <span>
            <span className="block text-sm font-medium">
              Reuse the installed provider CLI token
            </span>
            <span className="block text-xs text-muted-foreground">
              Opt in to the authenticated local CLI when no stored token exists.
            </span>
          </span>
          <Switch checked={useCliAuth} onCheckedChange={onUseCliAuthChange} disabled={disabled} />
        </label>
      )}
    </>
  );
}

function ForgeHostActions({
  status,
  pending,
  disabled,
  onSave,
  onDisconnect,
}: {
  status: ForgeAuthStatus;
  pending: boolean;
  disabled: boolean;
  onSave: () => void;
  onDisconnect: (hostname: string) => void;
}): ReactElement {
  return (
    <div className="flex items-center justify-end gap-2">
      {(status.token_present || status.use_cli_auth) && (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onDisconnect(status.hostname)}
        >
          <Trash2Icon className="mr-1.5 size-3.5" aria-hidden /> Disconnect
        </Button>
      )}
      <Button size="sm" disabled={disabled} onClick={onSave}>
        {pending && <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />}
        Test connection
      </Button>
    </div>
  );
}

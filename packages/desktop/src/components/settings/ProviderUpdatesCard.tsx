import { useState } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { ArrowRight, ArrowUpCircle, Check, Loader2, RefreshCw } from "lucide-react";
import {
  useCheckProviderUpdates,
  useGetProviderUpdates,
  type ProviderUpdateStatus,
} from "@/api/generated";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastError } from "@/lib/api-errors";
import { ProviderIcon } from "@/lib/provider-icons";
import { isBrowserRemote } from "@/lib/remote/device-token";
import { PROVIDER_UPDATES_SETTINGS_ANCHOR } from "@/lib/settings-anchors";
import { startProviderUpdate } from "@/stores/provider-updates";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { ErrorRow, LoadingRow } from "./SettingsStateRows";

/**
 * Installed and available versions for every registered provider — built-ins
 * and installed connectors alike — with a per-provider update action. The
 * list is provider-neutral: each provider's updater decides what "latest"
 * means; this card only renders the backend's status.
 */
export function ProviderUpdatesCard(): React.JSX.Element {
  const remote = isBrowserRemote();
  // The host's WebSocket subscription keeps this cache current; remote
  // clients have none and refetch.
  const query = useGetProviderUpdates({ query: { staleTime: remote ? undefined : Infinity } });
  const check = useCheckProviderUpdates();
  const checking =
    check.isPending || query.data?.providers.some((status) => status.activity === "checking");

  // The result arrives over the WebSocket like every other status change.
  const runCheck = (): void => {
    check.mutate(undefined, {
      onError: (error) => toastError(error, "Could not check for provider updates"),
    });
  };

  return (
    <SettingsGroup
      id={PROVIDER_UPDATES_SETTINGS_ANCHOR}
      title="Versions & updates"
      description={<CheckedAt checkedAt={query.data?.checked_at ?? null} />}
      action={
        <Button
          size="sm"
          variant="raised"
          onClick={runCheck}
          disabled={checking || remote}
          title={remote ? "Checks run on the host computer" : undefined}
        >
          <RefreshCw className={checking ? "animate-spin" : undefined} aria-hidden />
          {checking ? "Checking…" : "Check now"}
        </Button>
      }
    >
      <div className={query.data ? undefined : "p-4"}>
        {query.isLoading ? (
          <LoadingRow label="Loading provider versions…" />
        ) : query.isError || !query.data ? (
          <ErrorRow label="Could not load provider versions." />
        ) : (
          <ul>
            {query.data.providers.map((status) => (
              <li key={status.provider_id}>
                <ProviderUpdateRow status={status} remote={remote} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsGroup>
  );
}

function CheckedAt({ checkedAt }: { checkedAt: string | null }): React.JSX.Element {
  if (!checkedAt) {
    return <>Cadencr checks for new versions at launch and every 6 hours.</>;
  }
  const checked = new Date(checkedAt);
  const relative =
    Date.now() - checked.getTime() < 60_000
      ? "just now"
      : formatDistanceToNowStrict(checked, { addSuffix: true });
  return <>Last checked {relative}. Cadencr checks again every 6 hours.</>;
}

function ProviderUpdateRow({
  status,
  remote,
}: {
  status: ProviderUpdateStatus;
  remote: boolean;
}): React.JSX.Element {
  const failure = status.state === "check_failed" ? status.error : null;
  return (
    <SettingsRow
      divided
      align={failure ? "start" : "center"}
      icon={
        <ProviderIcon
          providerId={status.provider_id}
          alt=""
          className="size-5 shrink-0 rounded-sm"
        />
      }
      label={
        <span className="flex items-center gap-2">
          <span className="truncate">{status.label}</span>
          {status.origin === "installed_local" ? (
            <Badge variant="secondary">Connector</Badge>
          ) : null}
        </span>
      }
      description={
        <>
          <VersionLine status={status} />
          {failure ? (
            <span className="mt-1 block text-destructive line-clamp-3" title={failure}>
              {failure}
            </span>
          ) : null}
        </>
      }
      control={<RowAction key={status.latest_version ?? ""} status={status} remote={remote} />}
    />
  );
}

function VersionLine({ status }: { status: ProviderUpdateStatus }): React.JSX.Element {
  const current = status.current_version;
  const latest = status.latest_version;
  return (
    <span className="flex items-center gap-1.5 font-mono tabular-nums">
      {current ? <span>v{current}</span> : <span className="font-sans">Version unknown</span>}
      {status.state === "update_available" && latest ? (
        <>
          <ArrowRight className="size-3" aria-label="latest" />
          <span className="text-foreground">v{latest}</span>
        </>
      ) : null}
    </span>
  );
}

const STATE_LABELS: Record<ProviderUpdateStatus["state"], string> = {
  unchecked: "Not checked yet",
  up_to_date: "Up to date",
  update_available: "Update available",
  not_installed: "Not installed",
  unsupported: "Updates not managed",
  check_failed: "Check failed",
};

function RowAction({
  status,
  remote,
}: {
  status: ProviderUpdateStatus;
  remote: boolean;
}): React.JSX.Element {
  if (status.activity) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {status.activity === "updating" ? "Updating…" : "Checking…"}
      </span>
    );
  }
  if (status.state === "update_available" && status.latest_version) {
    return <UpdateControls status={status} remote={remote} />;
  }
  return (
    <span
      className={
        status.state === "check_failed"
          ? "text-xs text-destructive"
          : "flex items-center gap-1 text-xs text-muted-foreground"
      }
    >
      {status.state === "up_to_date" ? <Check className="size-3.5" aria-hidden /> : null}
      {STATE_LABELS[status.state]}
    </span>
  );
}

function UpdateControls({
  status,
  remote,
}: {
  status: ProviderUpdateStatus;
  remote: boolean;
}): React.JSX.Element {
  const latest = status.latest_version ?? "";
  const [target, setTarget] = useState(latest);
  const selectable = status.supports_target_version && status.available_versions.length > 1;
  const version = selectable && status.available_versions.includes(target) ? target : latest;

  return (
    <div className="flex items-center gap-2">
      {selectable ? (
        <Select value={version} onValueChange={setTarget} disabled={remote}>
          <SelectTrigger size="sm" aria-label={`${status.label} version`} className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {status.available_versions.map((available) => (
              <SelectItem key={available} value={available}>
                {available}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <Button
        size="sm"
        variant="raised"
        onClick={() => void startProviderUpdate(status, selectable ? version : undefined)}
        disabled={remote}
        title={remote ? "Updates run on the host computer" : undefined}
      >
        <ArrowUpCircle className="text-primary" aria-hidden />
        Update to {version}
      </Button>
    </div>
  );
}

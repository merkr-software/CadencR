import { CheckCircle2, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { marketplaceError } from "@/lib/marketplace";
import { useMarketplaceTrust, type MarketplaceTrust } from "@/hooks/useMarketplaceTrust";

const GUIDANCE: Record<NonNullable<MarketplaceTrust["recovery"]>, string> = {
  set_aside:
    "Cadencr can set this file aside — it is renamed beside itself, never deleted — and rebuild the trust from this build. Nothing installed is removed.",
  update_app:
    "This data folder was last used by a newer Cadencr. Update Cadencr to verify the marketplace again; the file is left as it is.",
  reinstall: "This build's own trust configuration is broken. Install an official Cadencr release.",
  repair: "Fix what the message above names, then restart Cadencr.",
};

/**
 * The registry trust every kind verifies with cannot be used: say why, and
 * offer the one way out the service reports. Nothing renders while it is fine.
 */
export function MarketplaceTrustNotice(): React.JSX.Element | null {
  const { status, setAside } = useMarketplaceTrust();
  const kept = setAside.data?.kept_at;
  if (status.isError)
    return (
      <Notice title="Couldn't check the marketplace's signing trust">
        <p className="text-xs text-destructive">{marketplaceError(status.error)}</p>
        <Button size="xs" variant="outline" onClick={() => void status.refetch()}>
          {status.isFetching ? "Checking…" : "Try again"}
        </Button>
      </Notice>
    );
  const trust = status.data;
  if (!trust || trust.status !== "invalid") {
    if (!kept) return null;
    return (
      <p role="status" className="flex gap-2 text-xs text-muted-foreground">
        <CheckCircle2 aria-hidden="true" className="mt-px size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 break-all">
          Trust rebuilt. The unreadable file was kept at {kept}.
        </span>
      </p>
    );
  }
  return (
    <Notice title="The marketplace can't verify anything right now">
      <p className="break-words text-xs text-destructive">
        {trust.error}
        {trust.error_code && <span className="text-muted-foreground"> ({trust.error_code})</span>}
      </p>
      {trust.recovery && (
        <p className="max-w-[72ch] text-xs text-muted-foreground">{GUIDANCE[trust.recovery]}</p>
      )}
      {setAside.isError && (
        <p role="alert" className="text-xs text-destructive">
          {marketplaceError(setAside.error)}
        </p>
      )}
      {trust.recovery === "set_aside" && (
        <Button
          size="xs"
          variant="outline"
          disabled={setAside.isPending}
          onClick={() => setAside.mutate()}
        >
          {setAside.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {setAside.isPending ? "Setting the file aside…" : "Set the file aside and rebuild"}
        </Button>
      )}
    </Notice>
  );
}

function Notice({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex gap-2.5 rounded-lg border border-destructive/40 bg-card px-3 py-2.5"
    >
      <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}

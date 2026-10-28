import type { ComponentProps, ReactNode } from "react";
import { CloudOff, Loader2, RefreshCw, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** The one tile grid: shelves, filtered results and the loading outline. */
export const TILE_GRID = "grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-3";

/** Re-checks the catalogs; the label says what is happening while it runs. */
export function CheckCatalogButton({
  refreshing,
  onRefresh,
  label = "Check for updates",
  ...props
}: {
  refreshing: boolean;
  onRefresh: () => void;
  label?: ReactNode;
} & Omit<ComponentProps<typeof Button>, "onClick" | "disabled">): React.JSX.Element {
  return (
    <Button variant="outline" size="sm" disabled={refreshing} onClick={onRefresh} {...props}>
      {refreshing ? (
        <Loader2 aria-hidden="true" className="animate-spin" />
      ) : (
        <RefreshCw aria-hidden="true" />
      )}
      {refreshing ? "Checking…" : label}
    </Button>
  );
}

/** Every empty or unavailable state on the marketplace pages shares one shape. */
export function MarketplaceEmpty({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <Icon aria-hidden="true" className="size-8 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      {detail && <p className="max-w-[52ch] text-xs text-muted-foreground">{detail}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

/** No kind has a current verified catalog: say so, and keep the way out visible. */
export function MarketplaceUnavailable({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  return (
    <MarketplaceEmpty
      icon={CloudOff}
      title="No verified catalog right now"
      detail="Browsing and installing need a current signed catalog. Everything already installed stays manageable from Installed."
      action={
        <CheckCatalogButton refreshing={refreshing} onRefresh={onRefresh} label="Try again" />
      }
    />
  );
}

/** No catalog feed is compiled into this build: not a failure, so no retry is offered. */
export function MarketplaceNotInBuild(): React.JSX.Element {
  return (
    <MarketplaceEmpty
      icon={CloudOff}
      title="The catalog isn't available in this build"
      detail="This build isn't connected to a plugin catalog, so there is nothing to browse or install. Anything already installed stays manageable from Installed."
    />
  );
}

/** First load: the showcase and a shelf, in outline. */
export function MarketplaceSkeleton(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading the marketplace" className="space-y-6">
      <Skeleton className="h-[280px] w-full rounded-xl" />
      <div className="flex gap-1.5">
        {[56, 88, 96].map((width) => (
          <Skeleton key={width} className="h-8 rounded-full" style={{ width }} />
        ))}
      </div>
      <div className={TILE_GRID}>
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="aspect-[4/3.4] rounded-lg" />
        ))}
      </div>
    </div>
  );
}

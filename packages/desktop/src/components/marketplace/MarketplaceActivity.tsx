import { CheckCircle2, CircleAlert, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { catalogSourceMissing, marketplaceError } from "@/lib/marketplace";
import { useMarketplaceState } from "./MarketplaceContext";

type Line = { tone: "error" | "info" | "done" | "busy"; text: string };

const ICONS = { error: CircleAlert, info: Info, done: CheckCircle2, busy: Loader2 } as const;

function useActivityLines(): Line[] {
  const { providers, themes, tabs, catalogMissing } = useMarketplaceState();
  const lines: Line[] = [];
  const error = (label: string, value: unknown) => {
    const message = marketplaceError(value);
    if (message) lines.push({ tone: "error", text: `${label}: ${message}` });
  };
  for (const [label, kind] of [
    ["Providers", providers],
    ["Themes", themes],
    ["Custom tabs", tabs],
  ] as const) {
    if (kind.mutation.isPending)
      lines.push({ tone: "busy", text: `Applying ${kind.mutation.variables?.id} change…` });
    if (kind.notice) lines.push(kind.notice);
    error(label, kind.mutation.error);
  }
  error("Provider catalog", providers.catalogQuery.error ?? providers.refresh.error);
  error("Installed providers", providers.inventoryQuery.error);
  error("Theme catalog", themes.catalog.error ?? themes.refresh.error);
  error("Installed themes", themes.inventory.error ?? themes.recovery.error);
  error("Tab catalog", tabs.catalog.error ?? tabs.refresh.error);
  error("Installed tabs", tabs.inventory.error ?? tabs.summaries.error ?? tabs.recovery.error);
  // A build with no feed says so once, on the page itself, not as three notices.
  if (!catalogMissing && tabs.catalog.data?.error)
    lines.push({ tone: "info", text: `Tab catalog: ${tabs.catalog.data.error}` });
  const providerCatalog = providers.catalogQuery.data;
  if (providerCatalog?.error && !catalogMissing)
    lines.push(
      catalogSourceMissing(providerCatalog)
        ? {
            tone: "info",
            text: "Providers are not available from a catalog in this build. Installed providers remain manageable.",
          }
        : { tone: "error", text: `Provider catalog: ${providerCatalog.error}` },
    );
  if (!catalogMissing && themes.catalog.data?.error)
    lines.push({ tone: "info", text: `Theme catalog: ${themes.catalog.data.error}` });
  const blocklist = providers.inventoryQuery.data?.blocklist;
  if (blocklist?.error) lines.push({ tone: "error", text: `Blocklist: ${blocklist.error}` });
  return lines;
}

/**
 * Everything in flight or worth knowing, in one place under the page header:
 * pending changes, confirmed results, and failures with their stable codes.
 */
export function MarketplaceActivity(): React.JSX.Element | null {
  const { providers, themes, tabs } = useMarketplaceState();
  const lines = useActivityLines();
  const queryFailed =
    providers.catalogQuery.isError ||
    providers.inventoryQuery.isError ||
    themes.catalog.isError ||
    tabs.catalog.isError ||
    tabs.inventory.isError ||
    tabs.summaries.isError;
  const themeStateFailed = themes.inventory.isError || themes.mutation.isError;
  if (!lines.length) return null;
  return (
    <div
      aria-live="polite"
      className="space-y-1.5 rounded-lg border border-border/80 bg-card px-3 py-2.5"
    >
      {lines.map((line) => {
        const Icon = ICONS[line.tone];
        return (
          <p
            key={`${line.tone}:${line.text}`}
            role={line.tone === "error" ? "alert" : "status"}
            className={
              line.tone === "error"
                ? "flex gap-2 text-xs text-destructive"
                : "flex gap-2 text-xs text-muted-foreground"
            }
          >
            <Icon
              aria-hidden="true"
              className={`mt-px size-3.5 shrink-0 ${line.tone === "busy" ? "animate-spin" : ""} ${line.tone === "done" ? "text-primary" : ""}`}
            />
            <span className="min-w-0 break-words">{line.text}</span>
          </p>
        );
      })}
      {(queryFailed || themeStateFailed) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {queryFailed && (
            <Button
              size="xs"
              variant="outline"
              disabled={
                providers.catalogQuery.isFetching ||
                providers.inventoryQuery.isFetching ||
                themes.catalog.isFetching ||
                tabs.catalog.isFetching ||
                tabs.inventory.isFetching
              }
              onClick={() => {
                void providers.catalogQuery.refetch();
                void providers.inventoryQuery.refetch();
                void themes.catalog.refetch();
                void tabs.catalog.refetch();
                void tabs.inventory.refetch();
                void tabs.summaries.refetch();
              }}
            >
              Retry loading
            </Button>
          )}
          {themeStateFailed && (
            <Button
              size="xs"
              variant="outline"
              disabled={themes.recovery.isPending || themes.mutation.isPending}
              onClick={() => themes.recovery.mutate()}
            >
              {themes.recovery.isPending ? "Reloading theme state…" : "Reload theme state"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

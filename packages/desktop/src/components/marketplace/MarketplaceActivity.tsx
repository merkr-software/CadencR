import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { CheckCircle2, CircleAlert, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { catalogSourceMissing, marketplaceError } from "@/lib/marketplace";
import { managedThemeInventoryError } from "@/lib/theme-marketplace";
import { useMarketplaceState } from "./MarketplaceContext";
import { KINDS } from "./kinds";

type Line = { key: string; tone: "error" | "info" | "done" | "busy"; text: string };

const ICONS = { error: CircleAlert, info: Info, done: CheckCircle2, busy: Loader2 } as const;

function useActivityLines(t: UiTranslator): Line[] {
  const { providers, themes, tabs, lsps, catalogMissing } = useMarketplaceState();
  const lines: Line[] = [];
  const diagnostic = (
    key: string,
    label: string,
    message: string | null | undefined,
    tone: "error" | "info" = "error",
  ) => {
    if (message)
      lines.push({
        key,
        tone,
        text: t("marketplace.activity.labeledError", "{{label}}: {{message}}", { label, message }),
      });
  };
  const error = (key: string, label: string, value: unknown) =>
    diagnostic(key, label, marketplaceError(value, t));
  for (const [key, state] of [
    ["provider", providers],
    ["theme", themes],
    ["tab", tabs],
    ["lsp", lsps],
  ] as const) {
    if (state.mutation.isPending)
      lines.push({
        key: `${key}-pending`,
        tone: "busy",
        text: t("marketplace.activity.applyingChange", "Applying {{id}} change…", {
          id: state.mutation.variables?.id,
        }),
      });
    if (state.notice)
      lines.push({ key: `${key}-notice`, tone: state.notice.tone, text: state.notice.text(t) });
    error(`${key}-mutation-error`, KINDS[key].plural(t), state.mutation.error);
  }
  const providerLabel = t("marketplace.activity.providerCatalog", "Provider catalog");
  const themeLabel = t("marketplace.activity.themeCatalog", "Theme catalog");
  const lspLabel = t("marketplace.activity.lspCatalog", "Language server catalog");
  const tabLabel = t("marketplace.activity.tabCatalog", "Tab catalog");
  error(
    "provider-catalog-error",
    providerLabel,
    providers.catalogQuery.error ?? providers.refresh.error,
  );
  error(
    "provider-inventory-error",
    t("marketplace.activity.installedProviders", "Installed providers"),
    providers.inventoryQuery.error,
  );
  error("theme-catalog-error", themeLabel, themes.catalog.error ?? themes.refresh.error);
  diagnostic(
    "theme-inventory-error",
    t("marketplace.activity.installedThemes", "Installed themes"),
    themes.inventory.error
      ? managedThemeInventoryError(themes.inventory.error, t)
      : marketplaceError(themes.recovery.error, t),
  );
  error("lsp-catalog-error", lspLabel, lsps.catalog.error ?? lsps.refresh.error);
  error(
    "lsp-inventory-error",
    t("marketplace.activity.installedLsps", "Installed language servers"),
    lsps.inventory.error ?? lsps.recovery.error,
  );
  error("tab-catalog-error", tabLabel, tabs.catalog.error ?? tabs.refresh.error);
  error(
    "tab-inventory-error",
    t("marketplace.activity.installedTabs", "Installed tabs"),
    tabs.inventory.error ?? tabs.summaries.error ?? tabs.recovery.error,
  );
  // A build with no feed says so once, on the page itself.
  if (!catalogMissing) {
    diagnostic("lsp-catalog-diagnostic", lspLabel, lsps.catalog.data?.error);
    diagnostic("tab-catalog-diagnostic", tabLabel, tabs.catalog.data?.error, "info");
    diagnostic("theme-catalog-diagnostic", themeLabel, themes.catalog.data?.error, "info");
    const providerCatalog = providers.catalogQuery.data;
    if (providerCatalog?.error && catalogSourceMissing(providerCatalog))
      lines.push({
        key: "provider-catalog-diagnostic",
        tone: "info",
        text: t(
          "marketplace.activity.providersNotAvailable",
          "Providers are not available from a catalog in this build. Installed providers remain manageable.",
        ),
      });
    else diagnostic("provider-catalog-diagnostic", providerLabel, providerCatalog?.error);
  }
  diagnostic(
    "blocklist-diagnostic",
    t("marketplace.activity.blocklist", "Blocklist"),
    providers.inventoryQuery.data?.blocklist.error,
  );
  return lines;
}

/**
 * Everything in flight or worth knowing, in one place under the page header:
 * pending changes, confirmed results, and failures with their stable codes.
 */
export function MarketplaceActivity(): React.JSX.Element | null {
  const { t } = useUiTranslation();
  const { providers, themes, tabs, lsps } = useMarketplaceState();
  const lines = useActivityLines(t);
  const queryFailed =
    providers.catalogQuery.isError ||
    providers.inventoryQuery.isError ||
    themes.catalog.isError ||
    tabs.catalog.isError ||
    tabs.inventory.isError ||
    tabs.summaries.isError ||
    lsps.catalog.isError ||
    lsps.inventory.isError;
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
            key={line.key}
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
                lsps.catalog.isFetching ||
                lsps.inventory.isFetching ||
                tabs.inventory.isFetching
              }
              onClick={() => {
                void providers.catalogQuery.refetch();
                void providers.inventoryQuery.refetch();
                void themes.catalog.refetch();
                void tabs.catalog.refetch();
                void tabs.inventory.refetch();
                void tabs.summaries.refetch();
                void lsps.catalog.refetch();
                void lsps.inventory.refetch();
              }}
            >
              {t("marketplace.marketplaceActivity.retryLoading", "Retry loading")}
            </Button>
          )}
          {themeStateFailed && (
            <Button
              size="xs"
              variant="outline"
              disabled={themes.recovery.isPending || themes.mutation.isPending}
              onClick={() => themes.recovery.mutate()}
            >
              {themes.recovery.isPending
                ? t("marketplace.activity.reloadingThemeState", "Reloading theme state…")
                : t("marketplace.activity.reloadThemeState", "Reload theme state")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

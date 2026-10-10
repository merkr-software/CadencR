import { useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { useMarketplace } from "@/hooks/useMarketplace";
import { groupPackages, usableCatalog, marketplaceError } from "@/lib/marketplace";
import { MarketplaceDetails } from "./MarketplaceDetails";
import { MarketplacePolicy } from "./MarketplacePolicy";
import { InstalledProvider } from "./InstalledProvider";

export function MarketplaceSection(): React.JSX.Element {
  const { catalogQuery, inventoryQuery, refresh, mutation, notice } = useMarketplace();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const catalog = catalogQuery.data;
  const inventory = inventoryQuery.data;
  const groups = useMemo(() => groupPackages(catalog?.index?.signed.packages ?? []), [catalog]);
  const filtered = useMemo(
    () =>
      groups.filter((entries) =>
        `${entries[0].agent.name} ${entries[0].agent.id} ${entries[0].agent.description} ${entries[0].host.publisher}`
          .toLowerCase()
          .includes(search.toLowerCase().trim()),
      ),
    [groups, search],
  );
  const selected = groups.find((entries) => entries[0].agent.id === selectedId);
  const current = usableCatalog(catalog);
  return (
    <SettingsSection
      id="marketplace"
      title="Marketplace"
      subtitle="Signed ACP providers · Browse · Installed"
    >
      <SettingsCard padded>
        <MarketplaceToolbar refresh={refresh} catalogQuery={catalogQuery} />
        <MarketplaceStatus
          catalogQuery={catalogQuery}
          inventoryQuery={inventoryQuery}
          refresh={refresh}
          mutation={mutation}
          notice={notice}
        />
        <Tabs defaultValue="browse">
          <TabsList aria-label="Marketplace views">
            <TabsTrigger value="browse">Browse</TabsTrigger>
            <TabsTrigger value="installed">
              Installed ({inventory?.providers.length ?? 0})
            </TabsTrigger>
          </TabsList>
          <MarketplaceBrowse
            search={search}
            setSearch={setSearch}
            current={current}
            loading={catalogQuery.isPending}
            filtered={filtered}
            hasPackages={groups.length > 0}
            onSelect={(id) => {
              setSelectedId(id);
            }}
          />
          <TabsContent value="installed">
            {inventoryQuery.isPending ? (
              <p role="status" className="py-4 text-sm">
                Loading installed providers…
              </p>
            ) : inventory?.providers.length ? (
              <div className="h-80">
                <Virtuoso
                  data={inventory.providers}
                  itemContent={(_, entry) => (
                    <InstalledProvider entry={entry} mutation={mutation} />
                  )}
                />
              </div>
            ) : (
              <p className="py-4 text-sm text-muted-foreground">
                {inventoryQuery.isError
                  ? "Installed providers could not be loaded."
                  : "No managed providers installed."}
              </p>
            )}
          </TabsContent>
        </Tabs>
        {selected && (
          <MarketplaceDetails
            key={selectedId}
            packages={selected}
            installed={inventory?.providers.find((entry) => entry.id === selectedId)}
            index={catalog?.index}
            canInstall={
              current &&
              !!inventory &&
              !inventoryQuery.isError &&
              inventory.trust.status === "configured"
            }
            mutation={mutation}
            onClose={() => setSelectedId(null)}
          />
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function MarketplaceStatus({
  catalogQuery,
  inventoryQuery,
  refresh,
  mutation,
  notice,
}: ReturnType<typeof useMarketplace>): React.JSX.Element {
  const catalog = catalogQuery.data;
  const inventory = inventoryQuery.data;
  const errors = [
    marketplaceError(catalogQuery.error),
    marketplaceError(inventoryQuery.error),
    marketplaceError(refresh.error),
    marketplaceError(mutation.error),
  ];
  return (
    <div className="mb-4 space-y-2 text-xs" aria-live="polite">
      {(catalogQuery.isPending || inventoryQuery.isPending) && (
        <p role="status" className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading marketplace…
        </p>
      )}
      {errors.filter(Boolean).map((error, i) => (
        <p key={i} role="alert" className="text-destructive">
          {error}
        </p>
      ))}
      {catalog?.error && (
        <p role="alert" className="text-destructive">
          {catalog.error_code}: {catalog.error}
        </p>
      )}
      {catalog && !catalog.source_configured && (
        <p className="text-muted-foreground">
          The catalog source is not configured in this build.
          {usableCatalog(catalog)
            ? " A still-valid verified cached catalog is available."
            : " Browse and installation are unavailable until a release configures it."}
        </p>
      )}
      {usableCatalog(catalog) && (
        <p className="text-muted-foreground">
          {catalog?.used_cached_verified_catalog
            ? "Using verified cached catalog"
            : "Verified catalog refreshed"}{" "}
          · signer {catalog?.signer_key_id} · expires {catalog?.expires_at}
        </p>
      )}
      {inventory?.trust.status !== "configured" && inventory && (
        <p className="text-muted-foreground">
          Signing trust: {inventory.trust.status}. {inventory.trust.error}
        </p>
      )}
      {inventory && <MarketplacePolicy inventory={inventory} />}
      {inventory?.blocklist.error && (
        <p role="alert" className="text-destructive">
          Blocklist: {inventory.blocklist.error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {mutation.isPending && <p role="status">Applying provider change…</p>}
      {(inventoryQuery.isError || catalogQuery.isError) && (
        <Button
          size="sm"
          variant="outline"
          disabled={inventoryQuery.isFetching || catalogQuery.isFetching}
          onClick={() => {
            void inventoryQuery.refetch();
            void catalogQuery.refetch();
          }}
        >
          Retry loading
        </Button>
      )}
    </div>
  );
}

function MarketplaceBrowse({
  search,
  setSearch,
  current,
  loading,
  filtered,
  hasPackages,
  onSelect,
}: {
  search: string;
  setSearch: (value: string) => void;
  current: boolean;
  loading: boolean;
  filtered: ReturnType<typeof groupPackages>;
  hasPackages: boolean;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <TabsContent value="browse">
      <Input
        aria-label="Search marketplace"
        placeholder="Search providers or publishers…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="mb-4"
      />
      {!current ? (
        <p className="py-4 text-sm text-muted-foreground">
          {loading
            ? "Loading signed catalog…"
            : "No current verified catalog is available. Refresh to retry; installed providers can still be managed."}
        </p>
      ) : filtered.length ? (
        <div className="h-80">
          <Virtuoso
            data={filtered}
            itemContent={(_, entries) => (
              <div className="flex items-start justify-between gap-4 border-b border-border py-4">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium">{entries[0].agent.name}</h3>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {entries[0].agent.description}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {entries[0].host.publisher} · {entries.length} version
                    {entries.length === 1 ? "" : "s"}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    onSelect(entries[0].agent.id);
                  }}
                >
                  Details
                </Button>
              </div>
            )}
          />
        </div>
      ) : (
        <p className="py-4 text-sm text-muted-foreground">
          {hasPackages
            ? "No providers match your search."
            : "The verified catalog has no providers yet."}
        </p>
      )}
    </TabsContent>
  );
}

function MarketplaceToolbar({
  refresh,
  catalogQuery,
}: Pick<ReturnType<typeof useMarketplace>, "refresh" | "catalogQuery">): React.JSX.Element {
  return (
    <div className="mb-4 flex items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">
        Discover providers from the official signed catalog.
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={refresh.isPending || catalogQuery.isFetching}
        onClick={() => refresh.mutate()}
      >
        <RefreshCw className="size-4" />
        {refresh.isPending || catalogQuery.isFetching ? "Refreshing…" : "Refresh catalog"}
      </Button>
    </div>
  );
}

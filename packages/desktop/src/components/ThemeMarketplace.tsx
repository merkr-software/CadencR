import { useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useThemeMarketplace } from "@/hooks/useThemeMarketplace";
import {
  groupThemePackages,
  usableThemeCatalog,
  managedThemeDefinition,
} from "@/lib/theme-marketplace";
import { marketplaceError } from "@/lib/marketplace";
import { ThemeSwatch } from "./theme/ThemeSwatch";
import { ThemeMarketplaceDetails } from "./ThemeMarketplaceDetails";

export function ThemeMarketplace(): React.JSX.Element {
  const state = useThemeMarketplace();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const groups = useMemo(() => groupThemePackages(state.catalog.data), [state.catalog.data]);
  const filtered = useMemo(
    () =>
      groups.filter((versions) =>
        `${versions[0].theme.name} ${versions[0].theme.id} ${versions[0].host.publisher}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
      ),
    [groups, search],
  );
  const packages = groups.find((versions) => versions[0].theme.id === selected);
  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Declarative themes: validated colors and bounded raster data, never executables.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={state.refresh.isPending || state.catalog.isFetching}
          onClick={() => state.refresh.mutate()}
        >
          {state.refresh.isPending || state.catalog.isFetching
            ? "Refreshing themes…"
            : "Refresh theme catalog"}
        </Button>
      </div>
      <ThemeMarketplaceStatus state={state} />
      <Input
        aria-label="Search marketplace themes"
        placeholder="Search themes or publishers…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {!usableThemeCatalog(state.catalog.data) ? (
        <p className="text-sm text-muted-foreground">
          No current verified mixed catalog. Installed themes remain manageable.
        </p>
      ) : filtered.length ? (
        <div className="h-64">
          <Virtuoso
            data={filtered}
            itemContent={(_, versions) => (
              <div className="flex justify-between gap-4 border-b py-3">
                <div>
                  <h3 className="text-sm font-medium">{versions[0].theme.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {versions[0].host.publisher} · {versions.length} version(s)
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSelected(versions[0].theme.id)}
                >
                  Theme details
                </Button>
              </div>
            )}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No matching themes in the verified catalog.</p>
      )}
      <h3 className="text-sm font-medium">
        Installed themes ({state.inventory.data?.length ?? 0})
      </h3>
      {!!state.inventory.data?.length && (
        <div className="h-64">
          <Virtuoso
            data={state.inventory.data}
            itemContent={(_, entry) => <InstalledTheme entry={entry} state={state} />}
          />
        </div>
      )}
      <ThemeRecovery state={state} />
      {packages && (
        <ThemeMarketplaceDetails
          key={selected}
          packages={packages}
          state={state}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
function InstalledTheme({
  entry,
  state,
}: {
  entry: NonNullable<ReturnType<typeof useThemeMarketplace>["inventory"]["data"]>[number];
  state: ReturnType<typeof useThemeMarketplace>;
}): React.JSX.Element {
  const [confirmFallback, setConfirmFallback] = useState(false);
  const [label, setLabel] = useState("");
  return (
    <div className="space-y-2 border-b py-3">
      <InstalledThemeSummary entry={entry} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={state.mutation.isPending || entry.active || !entry.theme}
          onClick={() => state.mutation.mutate({ kind: "apply", id: entry.id })}
        >
          {entry.active ? "Theme active" : "Activate theme"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={state.mutation.isPending}
          onClick={() => setConfirmFallback(true)}
        >
          Remove theme…
        </Button>
      </div>
      {confirmFallback && (
        <div className="space-y-2 rounded border p-2 text-xs">
          <p>
            Remove this installed theme? Any manual or system selection using it will return to a
            built-in theme.
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={state.mutation.isPending}
            onClick={() =>
              state.mutation.mutate(
                { kind: "remove", id: entry.id, confirmFallback: true },
                { onSuccess: () => setConfirmFallback(false) },
              )
            }
          >
            Confirm removal and built-in fallback
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={state.mutation.isPending}
            onClick={() => setConfirmFallback(false)}
          >
            Cancel removal
          </Button>
        </div>
      )}
      <div className="flex gap-2">
        <Input
          aria-label={`New author project name for ${entry.name}`}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="New editable theme name"
          disabled={state.mutation.isPending}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={state.mutation.isPending || !entry.theme || !label.trim()}
          onClick={() =>
            state.mutation.mutate(
              { kind: "duplicate", id: entry.id, label: label.trim() },
              { onSuccess: () => setLabel("") },
            )
          }
        >
          Duplicate to author project
        </Button>
      </div>
    </div>
  );
}

function ThemeMarketplaceStatus({
  state,
}: {
  state: ReturnType<typeof useThemeMarketplace>;
}): React.JSX.Element {
  const errors = [
    state.catalog.error,
    state.inventory.error,
    state.refresh.error,
    state.mutation.error,
    state.recovery.error,
  ].filter(Boolean);
  return (
    <>
      {(state.catalog.isLoading || state.inventory.isLoading) && (
        <p role="status">Loading marketplace themes…</p>
      )}
      {errors.map((error, index) => (
        <p key={index} role="alert" className="text-sm text-destructive">
          {marketplaceError(error)}
        </p>
      ))}
      {state.catalog.data?.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.catalog.data.error}
        </p>
      )}
      {state.notice && (
        <p role="status" className="text-sm">
          {state.notice}
        </p>
      )}
      {state.mutation.isPending && <p role="status">Applying theme change…</p>}
    </>
  );
}

function ThemeRecovery({
  state,
}: {
  state: ReturnType<typeof useThemeMarketplace>;
}): React.JSX.Element | null {
  if (!state.inventory.isError && !state.mutation.isError && !state.recovery.isError) return null;
  return (
    <Button
      variant="outline"
      disabled={state.inventory.isFetching || state.recovery.isPending || state.mutation.isPending}
      onClick={() => state.recovery.mutate()}
    >
      {state.inventory.isFetching || state.recovery.isPending
        ? "Reloading theme state…"
        : "Reload affected theme state"}
    </Button>
  );
}

function InstalledThemeSummary({
  entry,
}: {
  entry: NonNullable<ReturnType<typeof useThemeMarketplace>["inventory"]["data"]>[number];
}): React.JSX.Element {
  const theme = useMemo(() => (entry.theme ? managedThemeDefinition(entry) : null), [entry]);
  return (
    <>
      <div className="flex items-center gap-3">
        {theme && (
          <div className="w-20">
            <ThemeSwatch theme={theme} />
          </div>
        )}
        <div className="text-sm">
          {entry.name} · {entry.version}
          {entry.active ? " · Active" : ""}
        </div>
      </div>
      {entry.error && (
        <p role="alert" className="text-xs text-destructive">
          {entry.error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Signed revisions are immutable. Duplicate to create an editable plugin project.
      </p>
    </>
  );
}

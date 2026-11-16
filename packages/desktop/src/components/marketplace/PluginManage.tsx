import { useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { marketplaceError } from "@/lib/marketplace";
import type { MarketplaceListing, PluginKind } from "@/lib/marketplace-listings";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { installedPluginMembers } from "@/lib/marketplace-plugin-listings";
import { useMarketplaceState } from "./MarketplaceContext";
import { memberLabel, usePluginActions } from "./usePluginActions";

/** Removal across kinds and, for themes, duplicating into an editable author project. */
export function PluginManage({
  listing,
}: {
  listing: MarketplaceListing;
}): React.JSX.Element | null {
  const state = useMarketplaceState();
  const actions = usePluginActions();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pluginError, setPluginError] = useState<string | null>(null);
  if (!listing.installed) return null;
  if (listing.kind === "lsp" && !listing.installed.managed)
    return (
      <p className="text-xs text-muted-foreground">
        This server is installed outside the marketplace. Manage it with its original installer.
      </p>
    );
  const members = listing.kind === "plugin" ? installedPluginMembers(listing, state.listings) : [];
  const mutation =
    listing.kind === "plugin"
      ? null
      : { provider: state.providers, tab: state.tabs, theme: state.themes, lsp: state.lsps }[
          listing.kind
        ].mutation;
  // The kind's mutation is shared; only this plugin's removal failure belongs in the dialog.
  const removalError =
    mutation?.variables?.kind === "remove" && mutation.variables.id === listing.id
      ? marketplaceError(mutation.error)
      : pluginError;
  const busy = removing || actions.busy(listing);
  /** Resolves false on failure so the dialog stays open on its error. */
  const remove = async () => {
    setPluginError(null);
    setRemoving(true);
    try {
      if (listing.kind === "plugin") await actions.removePlugin(listing);
      else await actions.remove(listing);
      return true;
    } catch (error) {
      // A single kind's error is read from its mutation above; a plugin's names its member.
      if (listing.kind === "plugin") setPluginError(marketplaceError(error));
      return false;
    } finally {
      setRemoving(false);
    }
  };
  return (
    <section className="space-y-3">
      <h2 className="text-[13px] font-semibold">Manage</h2>
      {listing.kind === "theme" && <DuplicateTheme listing={listing} />}
      <Button
        variant="ghost"
        size="sm"
        className="px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        <Trash2 aria-hidden="true" />
        Remove {listing.name}…
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove ${listing.name}?`}
        description={
          listing.kind === "plugin" ? pluginRemoval(members) : removalDescription(listing.kind)
        }
        variant="destructive"
        confirmText={busy ? "Removing…" : "Remove"}
        busy={busy}
        onConfirm={remove}
      >
        {removalError && (
          <p role="alert" className="text-sm text-destructive">
            {removalError}
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}

function removalDescription(kind: PluginKind): string {
  if (kind === "provider")
    return "The provider is disabled and dropped from the next startup. Existing conversations are kept.";
  if (kind === "lsp")
    return "The managed server is removed. Saved language preferences are kept; open editors disconnect when their server becomes unavailable.";
  if (kind === "tab")
    return "The tab is removed from the workspace. Its configuration and retained revisions are kept.";
  return "Any light, dark or manual selection using this theme returns to a built-in theme.";
}

/** Every installed member goes, each with its own kind's consequences. */
function pluginRemoval(members: MarketplaceListing[]): string {
  const names = members.map(memberLabel).join(", ");
  const kinds = [...new Set(members.flatMap((member) => member.contributes))];
  return [`Removes ${names}.`, ...kinds.map(removalDescription)].join(" ");
}

/** A signed theme revision is immutable: copy it into an author project to edit it. */
function DuplicateTheme({ listing }: { listing: MarketplaceListing }): React.JSX.Element {
  const { themes } = useMarketplaceState();
  const [label, setLabel] = useState("");
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        Make an editable copy in a new author project.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label={`New author project name for ${listing.name}`}
          placeholder="New theme name"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          disabled={themes.mutation.isPending}
          className="h-8 text-[13px]"
        />
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={themes.mutation.isPending || !listing.installed?.usable || !label.trim()}
          onClick={() =>
            themes.mutation.mutate(
              { kind: "duplicate", id: listing.id, label: label.trim() },
              { onSuccess: () => setLabel("") },
            )
          }
        >
          <Copy aria-hidden="true" />
          Duplicate
        </Button>
      </div>
    </div>
  );
}

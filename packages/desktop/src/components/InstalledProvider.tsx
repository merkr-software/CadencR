import { useMemo, useState } from "react";
import type { ManagedProviderInventoryEntry } from "@/api/generated";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Virtuoso } from "react-virtuoso";
import { installedRevision, marketplaceError } from "@/lib/marketplace";
import type { useMarketplace } from "@/hooks/useMarketplace";

export function InstalledProvider({
  entry,
  mutation,
}: {
  entry: ManagedProviderInventoryEntry;
  mutation: ReturnType<typeof useMarketplace>["mutation"];
}): React.JSX.Element {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const present = installedRevision(entry);
  return (
    <div className="space-y-2 border-b border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{entry.id}</h3>
          <p className="text-xs text-muted-foreground">
            {entry.version ?? "Not installed"} ·{" "}
            {entry.active_now ? "Active now" : "Not active now"} ·{" "}
            {entry.enabled_after_restart ? "Enabled" : "Disabled"} after restart
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!present || mutation.isPending}
            onClick={() =>
              mutation.mutate({
                kind: "enabled",
                id: entry.id,
                enabled: !entry.enabled_after_restart,
              })
            }
          >
            {mutation.isPending && mutation.variables?.id === entry.id
              ? "Applying…"
              : entry.enabled_after_restart
                ? "Disable"
                : "Enable"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)}>
            History
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!present || mutation.isPending}
            onClick={() => setConfirmRemove(true)}
          >
            Remove
          </Button>
        </div>
      </div>
      {entry.restart_required && (
        <p role="status" className="text-xs text-muted-foreground">
          Restart Cadencr to apply changes.{" "}
          {entry.active_after_restart
            ? "This provider will be active."
            : "This provider will not be active."}
        </p>
      )}
      {entry.error && (
        <p role="alert" className="text-xs text-destructive">
          {entry.error_code}: {entry.error}
        </p>
      )}
      {entry.quarantine.length > 0 && (
        <p className="text-xs text-destructive">
          Last quarantine: {entry.quarantine.at(-1)?.code} — {entry.quarantine.at(-1)?.message}
        </p>
      )}
      <InstalledDialogs
        entry={entry}
        mutation={mutation}
        confirmRemove={confirmRemove}
        setConfirmRemove={setConfirmRemove}
        historyOpen={historyOpen}
        setHistoryOpen={setHistoryOpen}
      />
    </div>
  );
}

function InstalledDialogs({
  entry,
  mutation,
  confirmRemove,
  setConfirmRemove,
  historyOpen,
  setHistoryOpen,
}: {
  entry: ManagedProviderInventoryEntry;
  mutation: ReturnType<typeof useMarketplace>["mutation"];
  confirmRemove: boolean;
  setConfirmRemove: (value: boolean) => void;
  historyOpen: boolean;
  setHistoryOpen: (value: boolean) => void;
}): React.JSX.Element {
  const history = useMemo(
    () => (historyOpen ? [...entry.history].reverse() : []),
    [historyOpen, entry.history],
  );
  return (
    <>
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {entry.id}?</DialogTitle>
            <DialogDescription>
              The managed provider will be disabled and removed from the next startup registry.
              Existing conversations are preserved.
            </DialogDescription>
          </DialogHeader>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(
                { kind: "remove", id: entry.id },
                { onSuccess: () => setConfirmRemove(false) },
              )
            }
          >
            {mutation.isPending ? "Removing…" : "Confirm removal"}
          </Button>
          {mutation.error && (
            <p role="alert" className="text-sm text-destructive">
              {marketplaceError(mutation.error)}
            </p>
          )}
        </DialogContent>
      </Dialog>
      {historyOpen && (
        <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{entry.id} history</DialogTitle>
              <DialogDescription>Confirmed installation changes, newest first.</DialogDescription>
            </DialogHeader>
            {entry.history.length ? (
              <div className="h-72">
                <Virtuoso
                  data={history}
                  itemContent={(_, item) => (
                    <div className="border-b border-border py-2 text-sm">
                      <p>
                        {item.action.replaceAll("_", " ")} · {item.version ?? "—"}
                      </p>
                      <p className="text-xs text-muted-foreground">{item.occurred_at}</p>
                    </div>
                  )}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No history recorded.</p>
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

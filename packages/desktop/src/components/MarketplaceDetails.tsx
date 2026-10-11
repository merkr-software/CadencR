import { useState } from "react";
import type {
  ManagedProviderInventoryEntry,
  ManagedProviderPackage,
  SignedProviderCatalog,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { defaultMarketplaceVersion, installedRevision, marketplaceError } from "@/lib/marketplace";
import type { useMarketplace } from "@/hooks/useMarketplace";

type Mutation = ReturnType<typeof useMarketplace>["mutation"];
export function MarketplaceDetails({
  packages,
  installed,
  index,
  canInstall,
  recommendedVersion,
  mutation,
  onClose,
}: {
  packages: ManagedProviderPackage[];
  installed?: ManagedProviderInventoryEntry;
  index?: SignedProviderCatalog | null;
  canInstall: boolean;
  recommendedVersion?: string;
  mutation: Mutation;
  onClose: () => void;
}): React.JSX.Element {
  const [chosenVersion, setVersion] = useState<string | null>(null);
  const version = chosenVersion ?? defaultMarketplaceVersion(recommendedVersion, installed);
  const selected = packages.find((item) => item.agent.version === version);
  const entry =
    selected ?? packages.find((item) => item.agent.version === recommendedVersion) ?? packages[0];
  const present = installedRevision(installed);
  const sameVersion = present && installed?.version === version;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{entry.agent.name}</DialogTitle>
          <DialogDescription>{entry.agent.description}</DialogDescription>
        </DialogHeader>
        <PackageMetadata entry={entry} />
        {entry.agent.authors?.length ? (
          <p className="text-sm text-muted-foreground">Authors: {entry.agent.authors.join(", ")}</p>
        ) : null}
        <MarketplaceVersionSelect
          packages={packages}
          version={version}
          onChange={setVersion}
          recommendedVersion={recommendedVersion}
          installedAbsent={!!sameVersion && !selected}
        />
        <p role="status" className="text-xs text-muted-foreground">
          {recommendedVersion
            ? `Recommended for this host: ${recommendedVersion}.`
            : "No compatible version is recommended for this host. Choose a version explicitly."}
          {present ? " Installed versions are preserved until you explicitly choose a change." : ""}
        </p>
        <p className="text-xs text-muted-foreground">
          Installing downloads and runs this publisher’s executable. Cadencr verifies its signed
          catalog, package integrity, compatibility and ACP handshake. These checks and process
          cleanup are not an OS sandbox: the executable runs on your host with your access. Use an
          isolated environment for untrusted providers. Installed changes may require restarting
          Cadencr.
        </p>
        {!canInstall && (
          <p role="status" className="text-sm text-muted-foreground">
            A current verified catalog and available installation inventory are required to install.
          </p>
        )}
        {mutation.error && (
          <p role="alert" className="text-sm text-destructive">
            {marketplaceError(mutation.error)}
          </p>
        )}
        <Button
          disabled={!canInstall || !index || mutation.isPending || sameVersion || !selected}
          onClick={() => {
            if (index && selected)
              mutation.mutate({
                kind: present ? "update" : "install",
                id: selected.agent.id,
                version: selected.agent.version,
                index,
              });
          }}
        >
          {mutation.isPending
            ? "Applying…"
            : sameVersion
              ? "Installed version"
              : !selected
                ? "Choose a version"
                : `${present ? "Change to" : "Install"} ${entry.agent.version}`}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function MarketplaceVersionSelect({
  packages,
  version,
  onChange,
  recommendedVersion,
  installedAbsent,
}: {
  packages: ManagedProviderPackage[];
  version: string;
  onChange: (version: string) => void;
  recommendedVersion?: string;
  installedAbsent: boolean;
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <label className="text-sm" htmlFor="marketplace-version">
        Exact version
      </label>
      <Select value={version} onValueChange={onChange}>
        <SelectTrigger id="marketplace-version">
          <SelectValue placeholder="Choose an exact version" />
        </SelectTrigger>
        <SelectContent>
          {installedAbsent && (
            <SelectItem value={version}>{version} (installed; not in catalog)</SelectItem>
          )}
          {packages.map((item) => (
            <SelectItem key={item.agent.version} value={item.agent.version}>
              {item.agent.version}
              {item.agent.version === recommendedVersion ? " (recommended)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function PackageMetadata({ entry }: { entry: ManagedProviderPackage }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm">
      <dt className="text-muted-foreground">Publisher</dt>
      <dd>{entry.host.publisher}</dd>
      <dt className="text-muted-foreground">Provider ID</dt>
      <dd className="break-all font-mono">{entry.agent.id}</dd>
      <dt className="text-muted-foreground">License</dt>
      <dd>{entry.agent.license ?? "Not specified"}</dd>
      <dt className="text-muted-foreground">Application compatibility</dt>
      <dd>
        {entry.host.compatibility.min_app_version} –{" "}
        {entry.host.compatibility.max_app_version ?? "no upper bound"}
      </dd>
      <dt className="text-muted-foreground">Distribution</dt>
      <dd>{Object.keys(entry.agent.distribution ?? {}).join(", ") || "Not specified"}</dd>
    </dl>
  );
}

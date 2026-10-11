import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { previewManagedThemePackage, type SignedMixedCatalog } from "@/api/generated";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  managedThemeDataSchema,
  type ThemeMarketplacePackage,
  usableThemeCatalog,
} from "@/lib/theme-marketplace";
import { marketplaceError } from "@/lib/marketplace";
import { toThemeDefinition } from "@/lib/themes/user-theme";
import type { useThemeMarketplace } from "@/hooks/useThemeMarketplace";
import { ThemeSwatch } from "./theme/ThemeSwatch";

export function ThemeMarketplaceDetails({
  packages,
  state,
  onClose,
}: {
  packages: ThemeMarketplacePackage[];
  state: ReturnType<typeof useThemeMarketplace>;
  onClose: () => void;
}): React.JSX.Element {
  const id = packages[0].theme.id;
  const installed = state.inventory.data?.find((entry) => entry.id === id);
  const recommended = state.catalog.data?.recommended_versions[id];
  const [choice, setChoice] = useState<string | null>(null);
  const version = choice ?? installed?.version ?? recommended ?? "";
  const selected = packages.find((entry) => entry.theme.version === version);
  const metadata =
    selected ?? packages.find((entry) => entry.theme.version === recommended) ?? packages[0];
  const index = state.catalog.data?.index;
  const ready = usableThemeCatalog(state.catalog.data) && !!selected && !!index;
  const requestKey = JSON.stringify([
    id,
    version,
    selected?.theme.distribution.sha256,
    index?.signature?.value,
  ]);
  const preview = useThemePreview({ id, version, index, ready, requestKey });
  const same = installed?.version === version;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{metadata.theme.name}</DialogTitle>
          <DialogDescription>{metadata.theme.description}</DialogDescription>
        </DialogHeader>
        <ThemeMetadata metadata={metadata} />
        <ThemeVersionPicker
          packages={packages}
          version={version}
          recommended={recommended}
          installedVersion={installed?.version}
          onChoose={(value) => {
            setChoice(value);
            preview.reset();
          }}
        />
        <ThemeSafetyNotice recommended={recommended} />
        {(preview.error || state.mutation.error) && (
          <p role="alert" className="text-sm text-destructive">
            {marketplaceError(preview.error ?? state.mutation.error)}
          </p>
        )}
        <ValidatedPreview
          data={preview.data?.requestKey === requestKey ? preview.data.theme : undefined}
          id={id}
        />
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!ready || preview.isPending || state.mutation.isPending}
            onClick={() => preview.mutate()}
          >
            {preview.isPending ? "Validating theme preview…" : "Preview theme"}
          </Button>
          <Button
            disabled={
              !ready ||
              !state.inventory.isSuccess ||
              same ||
              state.mutation.isPending ||
              preview.isPending
            }
            onClick={() => {
              if (index && selected)
                state.mutation.mutate({
                  kind: installed ? "update" : "install",
                  id,
                  version,
                  index,
                });
            }}
          >
            {state.mutation.isPending
              ? "Installing theme…"
              : same
                ? "Theme version installed"
                : selected
                  ? `${installed ? "Change theme to" : "Install theme"} ${version}`
                  : "Choose a version"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function useThemePreview({
  id,
  version,
  index,
  ready,
  requestKey,
}: {
  id: string;
  version: string;
  index?: SignedMixedCatalog | null;
  ready: boolean;
  requestKey: string;
}) {
  const controller = useRef<AbortController | null>(null);
  const preview = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!ready || !index) throw new Error("Choose a version from a current signed catalog");
      controller.current?.abort();
      controller.current = new AbortController();
      const response = await previewManagedThemePackage(
        { theme_id: id, version, index },
        controller.current.signal,
      );
      managedThemeDataSchema.parse(response);
      return { theme: response, requestKey };
    },
  });
  useEffect(() => {
    preview.reset();
    return () => controller.current?.abort();
  }, [requestKey, preview.reset]);
  return preview;
}

function ThemeMetadata({ metadata }: { metadata: ThemeMarketplacePackage }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-2 gap-2 text-sm">
      <dt>Publisher</dt>
      <dd>{metadata.host.publisher}</dd>
      <dt>Theme ID</dt>
      <dd className="font-mono">{metadata.theme.id}</dd>
      <dt>License</dt>
      <dd>{metadata.theme.license}</dd>
      <dt>Application compatibility</dt>
      <dd>
        {metadata.host.compatibility.min_app_version} –{" "}
        {metadata.host.compatibility.max_app_version ?? "no upper bound"}
      </dd>
    </dl>
  );
}
function ThemeVersionPicker({
  packages,
  version,
  recommended,
  installedVersion,
  onChoose,
}: {
  packages: ThemeMarketplacePackage[];
  version: string;
  recommended?: string;
  installedVersion?: string;
  onChoose: (value: string) => void;
}): React.JSX.Element {
  return (
    <>
      <label htmlFor="marketplace-theme-version" className="text-sm">
        Exact theme version
      </label>
      <Select value={version} onValueChange={onChoose}>
        <SelectTrigger id="marketplace-theme-version">
          <SelectValue placeholder="Choose an exact version" />
        </SelectTrigger>
        <SelectContent>
          {installedVersion &&
            !packages.some((entry) => entry.theme.version === installedVersion) && (
              <SelectItem value={installedVersion}>
                {installedVersion} (installed; not in catalog)
              </SelectItem>
            )}
          {packages.map((entry) => (
            <SelectItem key={entry.theme.version} value={entry.theme.version}>
              {entry.theme.version}
              {entry.theme.version === recommended ? " (recommended)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}

function ValidatedPreview({
  data,
  id,
}: {
  data?: Awaited<ReturnType<typeof previewManagedThemePackage>>;
  id: string;
}): React.JSX.Element | null {
  const definition = useMemo(
    () => (data?.theme ? toThemeDefinition(id, data.theme, data.assets) : null),
    [data, id],
  );
  if (!definition) return null;
  return (
    <div className="space-y-2 rounded border p-3">
      <p className="text-xs">Verified archive preview — does not change the active theme.</p>
      <ThemeSwatch theme={definition} />
    </div>
  );
}

function ThemeSafetyNotice({ recommended }: { recommended?: string }): React.JSX.Element {
  return (
    <>
      <p role="status" className="text-xs text-muted-foreground">
        {recommended
          ? `Recommended compatible version: ${recommended}.`
          : "No compatible recommendation. Choose a version explicitly."}{" "}
        Installed versions are preserved until an explicit change.
      </p>
      <p className="text-xs text-muted-foreground">
        Only validated declarative colors and a bounded raster asset are installed. No provider
        command is launched. Installation does not activate the theme.
      </p>
    </>
  );
}

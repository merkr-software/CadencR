import { useState } from "react";
import {
  type PreparedPublicationPackage,
  useGetProjectPublicationReadiness,
  usePreparePublicationPackage,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { PublicationError } from "./PublicationError";
import { bundleIdFromArchivePath, ProviderPublicationRelease } from "./ProviderPublicationRelease";

export function ThemePublicationPackagePreparation({
  projectId,
  enabled,
  pluginKind = "theme",
}: {
  projectId: number;
  enabled: boolean;
  pluginKind?: "theme" | "tab";
}): React.JSX.Element {
  const isTab = pluginKind === "tab";
  const label = isTab ? "custom tab" : "theme";
  const [metadata, setMetadata] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [prepared, setPrepared] = useState<PreparedPublicationPackage | null>(null);
  const readiness = useGetProjectPublicationReadiness(projectId, { query: { enabled } });
  const prepare = usePreparePublicationPackage({ mutation: { onSuccess: setPrepared } });
  const canPrepare = reviewed && metadata.trim() !== "" && readiness.isSuccess;
  const invalidate = (): void => {
    setPrepared(null);
    prepare.reset();
  };
  return (
    <SettingsSection
      size="sm"
      title={isTab ? "Prepare a custom tab bundle" : "Prepare a declarative theme bundle"}
      subtitle={isTab ? "Compiled web interface and manifest" : "Platform-independent data only"}
    >
      <SettingsCard padded>
        <div className="space-y-4">
          <BundleDescription isTab={isTab} />
          {readiness.isLoading && <p role="status">Checking {label} project…</p>}
          {readiness.isError && (
            <PublicationError
              prefix={`Could not check the ${label} project`}
              error={readiness.error}
            />
          )}
          <label className="block space-y-1.5 text-sm font-medium">
            {isTab ? "Custom tab" : "Theme"} package metadata JSON
            <Textarea
              value={metadata}
              disabled={prepare.isPending}
              className="min-h-32 font-mono text-xs"
              placeholder={`{"kind":"${pluginKind}","package":{"${pluginKind}":{...},"host":{...}}}`}
              onChange={(event) => {
                setMetadata(event.target.value);
                invalidate();
              }}
            />
            <span className="block text-xs font-normal text-muted-foreground">
              Declare identity, version, publisher, repository, compatibility and the single archive
              URL. No platform target is needed.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={reviewed}
              disabled={prepare.isPending}
              aria-label={`I reviewed the ${label} data and metadata`}
              onCheckedChange={(value) => {
                setReviewed(value === true);
                invalidate();
              }}
            />
            I reviewed the {label} data and metadata.
          </label>
          {prepare.isError && (
            <PublicationError
              prefix={`Could not prepare the ${label} bundle`}
              error={prepare.error}
            />
          )}
          {prepared && (
            <div role="status" className="space-y-1 rounded border p-3 text-xs">
              <p>
                {isTab ? "Custom tab" : "Declarative theme"} bundle prepared; nothing published.
              </p>
              <p className="break-all font-mono">{prepared.archive_path}</p>
              <p className="break-all font-mono">SHA-256: {prepared.sha256}</p>
              <p>{prepared.size.toLocaleString()} bytes</p>
            </div>
          )}
          <Button
            disabled={!canPrepare || prepare.isPending}
            onClick={() => prepare.mutate({ id: projectId, data: { metadata_json: metadata } })}
          >
            {prepare.isPending ? `Preparing ${label} bundle…` : `Prepare ${label} bundle`}
          </Button>
          <ProviderPublicationRelease
            key={prepared?.archive_path ?? "theme-release"}
            pluginKind={pluginKind}
            projectId={projectId}
            initialBundleId={prepared ? bundleIdFromArchivePath(prepared.archive_path) : ""}
          />
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

function BundleDescription({ isTab }: { isTab: boolean }): React.JSX.Element {
  return (
    <p className="text-xs text-muted-foreground">
      {isTab
        ? "Cadencr snapshots tab.json, the declared icon and the compiled web directory. Build the tab first; sources, node_modules and Git history are excluded. Installed tabs require consent before activation."
        : "Cadencr snapshots only validated theme.json and its declared raster asset from this author project. Git history, scaffolding and other files are excluded. No executable, command or ACP runtime is included."}
    </p>
  );
}

import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import {
  type PreparedPublicationPackage,
  useGetProjectPublicationReadiness,
  usePreparePublicationPackage,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { apiErrorMessage } from "@/lib/api-errors";

export function ProviderPublicationPackagePreparation({
  projectId,
  enabled,
}: {
  projectId: number;
  enabled: boolean;
}): React.JSX.Element {
  const [metadataJson, setMetadataJson] = useState("");
  const [stagingDirectory, setStagingDirectory] = useState("");
  const [target, setTarget] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [prepared, setPrepared] = useState<PreparedPublicationPackage | null>(null);
  const readiness = useGetProjectPublicationReadiness(projectId, { query: { enabled } });
  const targets = readiness.data?.supported_package_targets ?? [];
  const mutation = usePreparePublicationPackage({
    mutation: { onSuccess: setPrepared },
  });
  const pending = mutation.isPending;
  const canPrepare =
    reviewed &&
    !readiness.isError &&
    !readiness.isLoading &&
    metadataJson.trim() !== "" &&
    stagingDirectory.trim() !== "" &&
    targets.includes(target);

  const invalidatePreparedResult = (): void => {
    setPrepared(null);
    mutation.reset();
  };

  const prepare = (): void => {
    if (!canPrepare) return;
    mutation.mutate({
      id: projectId,
      data: { metadata_json: metadataJson, staging_directory: stagingDirectory, target },
    });
  };

  return (
    <SettingsSection
      size="sm"
      title="Prepare a local provider bundle"
      subtitle="Explicit local file creation"
      description="Create an archive and managed package.json in a new app-owned folder. This action writes files, unlike the read-only checks above."
    >
      <SettingsCard padded>
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Your input and repository remain unchanged. This does not run the connector, publish to
            GitHub, create a release, submit anywhere, or approve conformance.
          </p>
          {!readiness.isLoading && !readiness.isError && targets.length > 0 ? (
            <PublicationPackageFields
              metadataJson={metadataJson}
              stagingDirectory={stagingDirectory}
              target={target}
              targets={targets}
              reviewed={reviewed}
              disabled={pending}
              onMetadataChange={(value) => {
                setMetadataJson(value);
                invalidatePreparedResult();
              }}
              onStagingChange={(value) => {
                setStagingDirectory(value);
                invalidatePreparedResult();
              }}
              onTargetChange={(value) => {
                setTarget(value);
                invalidatePreparedResult();
              }}
              onReviewedChange={(value) => {
                setReviewed(value);
                invalidatePreparedResult();
              }}
            />
          ) : (
            <PublicationTargetsUnavailable
              loading={readiness.isLoading}
              error={readiness.isError ? readiness.error : null}
              hasTargets={targets.length > 0}
            />
          )}
          {mutation.isError ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              Could not prepare the local bundle: {apiErrorMessage(mutation.error, "Unknown error")}
            </div>
          ) : null}
          {prepared ? <PreparedPackageResult prepared={prepared} /> : null}
          <Button type="button" disabled={!canPrepare || pending} onClick={prepare}>
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {pending ? "Preparing local bundle…" : "Prepare local bundle"}
          </Button>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

function PublicationTargetsUnavailable({
  loading,
  error,
  hasTargets,
}: {
  loading: boolean;
  error: unknown;
  hasTargets: boolean;
}): React.JSX.Element {
  if (loading) {
    return (
      <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading supported targets…
      </div>
    );
  }
  const message = error
    ? `Could not load supported package targets: ${apiErrorMessage(error, "Unknown error")}`
    : hasTargets
      ? "Supported package targets are not ready."
      : "No supported package targets were returned. Refresh the read-only checks and try again.";
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {message}
    </div>
  );
}

interface FieldsProps {
  metadataJson: string;
  stagingDirectory: string;
  target: string;
  targets: string[];
  reviewed: boolean;
  disabled: boolean;
  onMetadataChange: (value: string) => void;
  onStagingChange: (value: string) => void;
  onTargetChange: (value: string) => void;
  onReviewedChange: (value: boolean) => void;
}

function PublicationPackageFields(props: FieldsProps): React.JSX.Element {
  return (
    <fieldset disabled={props.disabled} className="space-y-4 disabled:opacity-60">
      <label className="block space-y-1.5 text-sm font-medium">
        Managed package metadata JSON
        <Textarea
          value={props.metadataJson}
          onChange={(event) => props.onMetadataChange(event.target.value)}
          placeholder="Paste the existing author-provided managed package JSON"
          className="min-h-32 font-mono text-xs"
        />
        <span className="block text-xs font-normal text-muted-foreground">
          Use the existing managed package JSON, not a host descriptor. Cadencr does not guess
          publisher, version, or URLs. Declare exactly one target, whose URL ends in .tar.gz or
          .tgz.
        </span>
      </label>
      <label className="block space-y-1.5 text-sm font-medium">
        Dedicated staging directory
        <Input
          value={props.stagingDirectory}
          onChange={(event) => props.onStagingChange(event.target.value)}
          placeholder="/absolute/path/to/reviewed-staging"
        />
        <span className="block text-xs font-normal text-muted-foreground">
          Choose an absolute, dedicated, reviewed, quiescent directory outside the project tree. Do
          not select the home directory itself or include credentials.
        </span>
      </label>
      <div className="space-y-1.5 text-sm font-medium">
        <label id="publication-binary-target-label">Binary target</label>
        <Select value={props.target} onValueChange={props.onTargetChange} disabled={props.disabled}>
          <SelectTrigger className="w-full" aria-labelledby="publication-binary-target-label">
            <SelectValue placeholder="Select one declared target" />
          </SelectTrigger>
          <SelectContent>
            {props.targets.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={props.reviewed}
          onCheckedChange={(checked) => props.onReviewedChange(checked === true)}
          aria-label="I reviewed staging and excluded credentials"
        />
        <span>I reviewed staging and excluded credentials.</span>
      </label>
    </fieldset>
  );
}

function PreparedPackageResult({
  prepared,
}: {
  prepared: PreparedPublicationPackage;
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-[var(--acc-green)]/30 bg-[var(--acc-green)]/5 p-3 text-sm"
    >
      <p className="flex items-center gap-2 font-medium text-[var(--acc-green)]">
        <CheckCircle2 className="size-4" aria-hidden /> Local bundle prepared
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Archive</dt>
        <dd className="break-all font-mono">{prepared.archive_path}</dd>
        <dt className="text-muted-foreground">Metadata</dt>
        <dd className="break-all font-mono">{prepared.metadata_path}</dd>
        <dt className="text-muted-foreground">SHA-256</dt>
        <dd className="break-all font-mono">{prepared.sha256}</dd>
        <dt className="text-muted-foreground">Size</dt>
        <dd>{prepared.size.toLocaleString()} bytes</dd>
        <dt className="text-muted-foreground">Target</dt>
        <dd className="font-mono">{prepared.target}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        Local files only; nothing was published or approved.
      </p>
    </div>
  );
}

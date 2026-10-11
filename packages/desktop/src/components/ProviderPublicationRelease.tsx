import { useState } from "react";
import { Loader2 } from "lucide-react";
import { type PublicationReleasePreview } from "@/api/generated";
import { useReleaseCandidate } from "./ProviderPublicationReleaseCandidate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ProviderPublicationContribution } from "./ProviderPublicationContribution";
import { ProviderPublicationRegistry } from "./ProviderPublicationRegistry";
import { ReleaseOutcome } from "./PublicationReleaseOutcome";
import { PublicationError } from "./PublicationError";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function bundleIdFromArchivePath(archivePath: string): string {
  const segments = archivePath.split(/[\\/]/).filter(Boolean);
  const parent = segments.at(-2) ?? "";
  return UUID_PATTERN.test(parent) ? parent : "";
}

export function ProviderPublicationRelease({
  projectId,
  initialBundleId = "",
  pluginKind = "provider",
}: {
  projectId: number;
  initialBundleId?: string;
  pluginKind?: "provider" | "theme";
}): React.JSX.Element {
  const [registryOperationId, setRegistryOperationId] = useState<string>();
  const {
    bundleId,
    setBundleId,
    additionalBundles,
    setAdditionalBundles,
    releaseNotes,
    setReleaseNotes,
    preview,
    confirmed,
    setConfirmed,
    publishedUrl,
    contributionPending,
    setContributionPending,
    registryPending,
    setRegistryPending,
    previewMutation,
    publishMutation,
    pending,
    validInput,
    invalidatePreview,
    review,
    publish,
  } = useReleaseCandidate(projectId, initialBundleId);

  const releaseAttempted = publishMutation.isPending || publishMutation.isError || !!publishedUrl;
  const operationId = registryOperationId ?? (releaseAttempted ? preview?.operation_id : undefined);
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <ReleaseInputs
        pluginKind={pluginKind}
        bundleId={bundleId}
        additionalBundles={additionalBundles}
        onAdditionalBundlesChange={(value) => {
          setAdditionalBundles(value);
          invalidatePreview();
        }}
        releaseNotes={releaseNotes}
        disabled={pending}
        onBundleIdChange={(value) => {
          setBundleId(value);
          invalidatePreview();
        }}
        onReleaseNotesChange={(value) => {
          setReleaseNotes(value);
          invalidatePreview();
        }}
      />
      {previewMutation.isError ? (
        <PublicationError
          prefix="Could not review the GitHub publication"
          error={previewMutation.error}
        />
      ) : null}
      <ReviewReleaseButton
        disabled={!validInput || pending}
        reviewing={previewMutation.isPending}
        onReview={() => {
          setRegistryOperationId(undefined);
          review();
        }}
      />
      {preview ? (
        <PublicationPlanActions
          projectId={projectId}
          preview={preview}
          confirmed={confirmed}
          pending={pending}
          remotePending={previewMutation.isPending || publishMutation.isPending}
          publishing={publishMutation.isPending}
          onConfirmedChange={setConfirmed}
          onPublish={() => {
            setRegistryOperationId(undefined);
            publish();
          }}
          onContributionPendingChange={setContributionPending}
          contributionPending={contributionPending}
          registryPending={registryPending}
          onRegistryPendingChange={setRegistryPending}
          onRegistryOperationChange={setRegistryOperationId}
        />
      ) : null}
      <ReleaseOutcome
        projectId={projectId}
        registryPending={registryPending}
        operationId={operationId}
        mutation={publishMutation}
        publishedUrl={publishedUrl}
      />
    </div>
  );
}

function ReviewReleaseButton({
  disabled,
  reviewing,
  onReview,
}: {
  disabled: boolean;
  reviewing: boolean;
  onReview: () => void;
}): React.JSX.Element {
  return (
    <Button type="button" variant="outline" disabled={disabled} onClick={onReview}>
      {reviewing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
      {reviewing ? "Reviewing GitHub publication…" : "Review GitHub publication"}
    </Button>
  );
}

function PublicationPlanActions({
  projectId,
  preview,
  confirmed,
  pending,
  remotePending,
  publishing,
  onConfirmedChange,
  onPublish,
  onContributionPendingChange,
  contributionPending,
  registryPending,
  onRegistryPendingChange,
  onRegistryOperationChange,
}: {
  projectId: number;
  preview: PublicationReleasePreview;
  confirmed: boolean;
  pending: boolean;
  remotePending: boolean;
  publishing: boolean;
  onConfirmedChange: (value: boolean) => void;
  onPublish: () => void;
  onContributionPendingChange: (value: boolean) => void;
  contributionPending: boolean;
  registryPending: boolean;
  onRegistryPendingChange: (value: boolean) => void;
  onRegistryOperationChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <>
      <PublicationPreview
        preview={preview}
        confirmed={confirmed}
        pending={pending}
        publishing={publishing}
        onConfirmedChange={onConfirmedChange}
        onPublish={onPublish}
      />
      <ProviderPublicationContribution
        key={`contribution-${preview.plan_sha256}`}
        projectId={projectId}
        preview={preview}
        disabled={remotePending || registryPending}
        onPendingChange={onContributionPendingChange}
      />
      <ProviderPublicationRegistry
        key={`registry-${preview.plan_sha256}`}
        projectId={projectId}
        preview={preview}
        disabled={remotePending || contributionPending}
        onPendingChange={onRegistryPendingChange}
        onOperationChange={onRegistryOperationChange}
      />
    </>
  );
}

function ReleaseInputs({
  pluginKind,
  additionalBundles,
  onAdditionalBundlesChange,
  bundleId,
  releaseNotes,
  disabled,
  onBundleIdChange,
  onReleaseNotesChange,
}: {
  pluginKind: "provider" | "theme";
  additionalBundles: string;
  onAdditionalBundlesChange: (value: string) => void;
  bundleId: string;
  releaseNotes: string;
  disabled: boolean;
  onBundleIdChange: (value: string) => void;
  onReleaseNotesChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <>
      <div className="space-y-1">
        <h4 className="text-sm font-medium">Publish the prepared bundle to GitHub</h4>
        <p className="text-xs text-muted-foreground">
          Requires a configured GitHub connection, an existing public repository, and a clean local
          HEAD whose origin and already-pushed tag match the archive URL. Cadencr will not push
          source, create a tag, or submit to a registry.
        </p>
      </div>
      <fieldset disabled={disabled} className="space-y-4 disabled:opacity-60">
        <label className="block space-y-1.5 text-sm font-medium">
          Prepared bundle UUID
          <Input
            value={bundleId}
            onChange={(event) => onBundleIdChange(event.target.value)}
            placeholder="00000000-0000-4000-8000-000000000000"
          />
          <span className="block text-xs font-normal text-muted-foreground">
            Filled from the prepared archive when available. For a restart or retry, paste the UUID
            from its parent folder; arbitrary archive paths are not accepted.
          </span>
        </label>
        {pluginKind === "provider" && (
          <label className="block space-y-1.5 text-sm font-medium">
            Other platform bundle UUIDs
            <Textarea
              value={additionalBundles}
              onChange={(event) => onAdditionalBundlesChange(event.target.value)}
              placeholder="One UUID per platform, separated by spaces or commas"
            />
            <span className="block text-xs font-normal text-muted-foreground">
              Prepare each declared platform first. All bundles form one immutable version with one
              manifest.
            </span>
          </label>
        )}
        <label className="block space-y-1.5 text-sm font-medium">
          Release notes
          <Textarea
            value={releaseNotes}
            onChange={(event) => onReleaseNotesChange(event.target.value)}
            placeholder="Describe this release for its GitHub release page"
            className="min-h-24"
          />
        </label>
      </fieldset>
    </>
  );
}

function PublicationPreview({
  preview,
  confirmed,
  pending,
  publishing,
  onConfirmedChange,
  onPublish,
}: {
  preview: PublicationReleasePreview;
  confirmed: boolean;
  pending: boolean;
  publishing: boolean;
  onConfirmedChange: (value: boolean) => void;
  onPublish: () => void;
}): React.JSX.Element {
  const rows: [string, string][] = [
    ["Destination", preview.repository],
    ["Actor", preview.account],
    ["Tag", preview.tag],
    ["Source commit", preview.source_commit],
    ["Archive SHA-256", preview.archive_sha256],
    ["Archive file", preview.archive_name],
    ["Archive size", `${preview.archive_size.toLocaleString()} bytes`],
    ["Metadata SHA-256", preview.metadata_sha256],
    ["Content", preview.target || "Platform-independent declarative theme"],
    ["Version", preview.version],
    ["Release channel", preview.prerelease ? "Prerelease" : "Stable"],
  ];
  return (
    <div className="space-y-3 rounded-lg border border-[var(--acc-orange)]/30 bg-[var(--acc-orange)]/5 p-3 text-sm">
      <p className="font-medium">GitHub publication preview</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <ReleaseDetail key={label} label={label} value={value} />
        ))}
        <dt className="text-muted-foreground">Release notes</dt>
        <dd className="whitespace-pre-wrap break-words">{preview.release_notes}</dd>
      </dl>
      {preview.archives?.map((archive) => (
        <div key={archive.bundle_id} className="rounded border p-2 text-xs font-mono break-all">
          {archive.target || "Theme data"} · {archive.archive_name} ·{" "}
          {archive.archive_size.toLocaleString()} bytes
          <div>SHA-256: {archive.archive_sha256}</div>
        </div>
      ))}
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={confirmed}
          disabled={pending}
          onCheckedChange={(checked) => onConfirmedChange(checked === true)}
          aria-label="I confirm this exact GitHub publication"
        />
        <span>
          I confirm this exact destination, actor, tag, source, all package archives, manifest,
          version, and notes.
        </span>
      </label>
      <Button type="button" disabled={!confirmed || pending} onClick={onPublish}>
        {publishing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {publishing ? "Publishing GitHub release…" : "Publish GitHub release"}
      </Button>
    </div>
  );
}

function ReleaseDetail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono">{value}</dd>
    </>
  );
}

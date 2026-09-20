import { useState } from "react";
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import {
  type PublicationReleasePreview,
  usePreviewPublicationRelease,
  usePublishPublicationRelease,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { openExternalUrl } from "@/lib/open-external";
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
}: {
  projectId: number;
  initialBundleId?: string;
}): React.JSX.Element {
  const [bundleId, setBundleId] = useState(initialBundleId);
  const [releaseNotes, setReleaseNotes] = useState("");
  const [preview, setPreview] = useState<PublicationReleasePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null);
  const previewMutation = usePreviewPublicationRelease({
    mutation: { onSuccess: setPreview },
  });
  const publishMutation = usePublishPublicationRelease({
    mutation: { onSuccess: (result) => setPublishedUrl(result.release_url) },
  });
  const pending = previewMutation.isPending || publishMutation.isPending;
  const validInput = UUID_PATTERN.test(bundleId.trim()) && releaseNotes.trim() !== "";

  const invalidatePreview = (): void => {
    setPreview(null);
    setConfirmed(false);
    setPublishedUrl(null);
    previewMutation.reset();
    publishMutation.reset();
  };

  const review = (): void => {
    if (!validInput || pending) return;
    invalidatePreview();
    previewMutation.mutate({
      id: projectId,
      data: { bundle_id: bundleId.trim(), release_notes: releaseNotes },
    });
  };

  const publish = (): void => {
    if (!preview || !confirmed || pending) return;
    publishMutation.mutate({
      id: projectId,
      data: {
        bundle_id: preview.bundle_id,
        release_notes: preview.release_notes,
        expected_plan_sha256: preview.plan_sha256,
        confirmed: true,
      },
    });
  };

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <ReleaseInputs
        bundleId={bundleId}
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
      <Button type="button" variant="outline" disabled={!validInput || pending} onClick={review}>
        {previewMutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {previewMutation.isPending ? "Reviewing GitHub publication…" : "Review GitHub publication"}
      </Button>
      {preview ? (
        <PublicationPreview
          preview={preview}
          confirmed={confirmed}
          pending={pending}
          onConfirmedChange={setConfirmed}
          onPublish={publish}
        />
      ) : null}
      {publishMutation.isError ? (
        <PublicationError
          prefix="Could not publish the GitHub release"
          error={publishMutation.error}
        />
      ) : null}
      {publishMutation.isPending ? (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Publishing GitHub release…
        </div>
      ) : null}
      {publishedUrl ? <PublishedRelease releaseUrl={publishedUrl} /> : null}
    </div>
  );
}

function ReleaseInputs({
  bundleId,
  releaseNotes,
  disabled,
  onBundleIdChange,
  onReleaseNotesChange,
}: {
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
  onConfirmedChange,
  onPublish,
}: {
  preview: PublicationReleasePreview;
  confirmed: boolean;
  pending: boolean;
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
    ["Target", preview.target],
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
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={confirmed}
          disabled={pending}
          onCheckedChange={(checked) => onConfirmedChange(checked === true)}
          aria-label="I confirm this exact GitHub publication"
        />
        <span>
          I confirm this exact destination, actor, tag, source, archive, version, and notes.
        </span>
      </label>
      <Button type="button" disabled={!confirmed || pending} onClick={onPublish}>
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {pending ? "Publishing GitHub release…" : "Publish GitHub release"}
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

function PublishedRelease({ releaseUrl }: { releaseUrl: string }): React.JSX.Element {
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-[var(--acc-green)]/30 bg-[var(--acc-green)]/5 p-3 text-sm"
    >
      <p className="flex items-center gap-2 font-medium text-[var(--acc-green)]">
        <CheckCircle2 className="size-4" aria-hidden /> GitHub release published
      </p>
      <Button
        type="button"
        variant="link"
        className="h-auto justify-start whitespace-normal break-all p-0"
        onClick={() => void openExternalUrl(releaseUrl, "Could not open the GitHub release.")}
      >
        {releaseUrl} <ExternalLink className="size-3" aria-hidden />
      </Button>
    </div>
  );
}

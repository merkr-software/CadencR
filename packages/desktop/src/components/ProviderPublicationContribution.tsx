import { useState } from "react";
import { CheckCircle2, Copy, FolderOpen, Loader2 } from "lucide-react";
import {
  type PreparedPublicationContribution,
  type PublicationReleasePreview,
  usePreparePublicationContribution,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { copyToClipboard } from "@/lib/clipboard";
import { desktopBridge } from "@/lib/desktop-bridge";
import { toastError } from "@/lib/api-errors";
import { PublicationError } from "./PublicationError";

export function ProviderPublicationContribution({
  projectId,
  preview,
  disabled,
  onPendingChange,
}: {
  projectId: number;
  preview: PublicationReleasePreview;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
}): React.JSX.Element {
  const [confirmed, setConfirmed] = useState(false);
  const [prepared, setPrepared] = useState<PreparedPublicationContribution | null>(null);
  const mutation = usePreparePublicationContribution({
    mutation: {
      onSuccess: setPrepared,
      onSettled: () => onPendingChange(false),
    },
  });

  const prepare = (): void => {
    if (!confirmed || disabled || mutation.isPending) return;
    setConfirmed(false);
    setPrepared(null);
    mutation.reset();
    onPendingChange(true);
    mutation.mutate({
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
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <div className="space-y-1">
        <p className="font-medium">Prepare a local registry contribution</p>
        <p className="text-xs text-muted-foreground">
          This verifies the exact GitHub release is already published, then writes contribution
          files locally. It does not submit a pull request, obtain registry acceptance, or sign the
          contribution. Missing or draft releases are not published automatically.
        </p>
      </div>
      <label className="flex items-start gap-2">
        <Checkbox
          checked={confirmed}
          disabled={disabled || mutation.isPending}
          onCheckedChange={(checked) => setConfirmed(checked === true)}
          aria-label="I confirm local file creation and read-only GitHub verification"
        />
        <span>
          I confirm local file creation and read-only GitHub verification for this exact preview.
        </span>
      </label>
      <Button
        type="button"
        variant="outline"
        disabled={!confirmed || disabled || mutation.isPending}
        onClick={prepare}
      >
        {mutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {mutation.isPending ? "Preparing registry contribution…" : "Prepare registry contribution"}
      </Button>
      {mutation.isError ? (
        <PublicationError
          prefix="Could not prepare the registry contribution"
          error={mutation.error}
        />
      ) : null}
      {prepared ? <PreparedContributionResult prepared={prepared} /> : null}
    </div>
  );
}

function PreparedContributionResult({
  prepared,
}: {
  prepared: PreparedPublicationContribution;
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="space-y-3 rounded-lg border border-[var(--acc-green)]/30 bg-[var(--acc-green)]/5 p-3"
    >
      <p className="flex items-center gap-2 font-medium text-[var(--acc-green)]">
        <CheckCircle2 className="size-4" aria-hidden /> Local contribution files prepared
      </p>
      <dl className="space-y-2 text-xs">
        <PathDetail label="Output directory" path={prepared.output_directory} reveal />
        <PathDetail label="Package metadata" path={prepared.package_path} />
        <PathDetail label="Submission metadata" path={prepared.submission_path} />
        <PathDetail label="Pull request instructions" path={prepared.pull_request_path} />
      </dl>
      <p className="text-xs text-muted-foreground">
        Local files only. No pull request was submitted, accepted, or signed.
      </p>
    </div>
  );
}

function PathDetail({
  label,
  path,
  reveal = false,
}: {
  label: string;
  path: string;
  reveal?: boolean;
}): React.JSX.Element {
  const [revealPending, setRevealPending] = useState(false);
  const revealPath = async (): Promise<void> => {
    setRevealPending(true);
    try {
      await desktopBridge.revealInFinder(path);
    } catch (error) {
      toastError(error, "Could not reveal the contribution files.");
    } finally {
      setRevealPending(false);
    }
  };
  return (
    <div className="space-y-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 flex-1 break-all font-mono">{path}</span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => void copyToClipboard(path, `${label} copied`)}
        >
          <Copy className="size-3.5" aria-hidden />
        </Button>
        {reveal ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={revealPending}
            aria-label={
              revealPending ? "Revealing contribution files" : "Reveal contribution files"
            }
            onClick={() => void revealPath()}
          >
            {revealPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <FolderOpen className="size-3.5" aria-hidden />
            )}
          </Button>
        ) : null}
      </dd>
    </div>
  );
}

import { useState } from "react";
import { CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import {
  type PublicationRegistryPreview,
  type PublicationRegistryResult,
  type PublicationReleasePreview,
  usePreviewPublicationRegistry,
  useSubmitPublicationRegistry,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { openExternalUrl } from "@/lib/open-external";
import { PublicationError } from "./PublicationError";

export function ProviderPublicationRegistry({
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
  const [plan, setPlan] = useState<PublicationRegistryPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<PublicationRegistryResult | null>(null);
  const previewMutation = usePreviewPublicationRegistry({
    mutation: {
      onSuccess: (value) => setPlan(value),
      onSettled: () => onPendingChange(false),
    },
  });
  const submitMutation = useSubmitPublicationRegistry({
    mutation: {
      onSuccess: (value) => setResult(value),
      onSettled: () => onPendingChange(false),
    },
  });
  const pending = previewMutation.isPending || submitMutation.isPending;

  const resetReview = (): void => {
    setPlan(null);
    setConfirmed(false);
    setResult(null);
    previewMutation.reset();
    submitMutation.reset();
  };
  const review = (): void => {
    if (disabled || pending) return;
    resetReview();
    onPendingChange(true);
    previewMutation.mutate({
      id: projectId,
      data: { bundle_id: preview.bundle_id, release_notes: preview.release_notes },
    });
  };
  const submit = (): void => {
    if (!plan || !confirmed || disabled || pending) return;
    setConfirmed(false);
    setResult(null);
    submitMutation.reset();
    onPendingChange(true);
    submitMutation.mutate({
      id: projectId,
      data: {
        bundle_id: plan.bundle_id,
        release_notes: plan.release_notes,
        expected_plan_sha256: plan.plan_sha256,
        confirmed: true,
      },
    });
  };

  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <RegistryIntroduction />
      <Button type="button" variant="outline" disabled={disabled || pending} onClick={review}>
        {previewMutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {previewMutation.isPending
          ? "Reviewing registry submission…"
          : "Review registry submission"}
      </Button>
      {previewMutation.isError ? (
        <PublicationError
          prefix="Could not review the registry submission"
          error={previewMutation.error}
        />
      ) : null}
      {plan ? (
        <RegistryPlanReview
          plan={plan}
          confirmed={confirmed}
          disabled={disabled || pending}
          pending={submitMutation.isPending}
          onConfirmedChange={setConfirmed}
          onSubmit={submit}
        />
      ) : null}
      {submitMutation.isError ? (
        <PublicationError
          prefix="Could not submit the registry pull request"
          error={submitMutation.error}
        />
      ) : null}
      {submitMutation.isPending ? <RegistrySubmissionPending /> : null}
      {result ? <RegistrySubmissionResult result={result} /> : null}
    </div>
  );
}

function RegistryIntroduction(): React.JSX.Element {
  return (
    <div className="space-y-1">
      <p className="font-medium">Submit to the Cadencr marketplace registry</p>
      <p className="text-xs text-muted-foreground">
        Review a plan for <span className="font-mono">merkr-software/cadencr-registry</span>, then
        separately confirm creation or reuse of your fork branch and pull request. This does not
        accept, merge, or publish the submission. A remote timeout may leave a fork or branch;
        Cadencr will not automatically retry writes.
      </p>
    </div>
  );
}

function RegistrySubmissionPending(): React.JSX.Element {
  return (
    <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden /> Creating registry pull request…
    </div>
  );
}

function RegistryPlanReview({
  plan,
  confirmed,
  disabled,
  pending,
  onConfirmedChange,
  onSubmit,
}: {
  plan: PublicationRegistryPreview;
  confirmed: boolean;
  disabled: boolean;
  pending: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  const rows: [string, string][] = [
    ["Destination", plan.registry_repository],
    ["GitHub account", plan.account],
    ["Base", `${plan.base_branch} @ ${plan.base_commit}`],
    ["Fork branch", plan.branch],
    ["Package path", plan.package_path],
    ["Submission path", plan.submission_path],
    ["Plugin", plan.plugin_id],
    ["Version", plan.version],
  ];
  return (
    <div className="space-y-3 rounded-lg border border-[var(--acc-orange)]/30 bg-[var(--acc-orange)]/5 p-3">
      <p className="font-medium">Registry pull request preview</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <RegistryDetail key={label} label={label} value={value} />
        ))}
        <dt className="text-muted-foreground">Release notes</dt>
        <dd className="whitespace-pre-wrap break-words">{plan.release_notes}</dd>
      </dl>
      <label className="flex items-start gap-2">
        <Checkbox
          checked={confirmed}
          disabled={disabled}
          onCheckedChange={(checked) => onConfirmedChange(checked === true)}
          aria-label="I confirm this exact fork, branch, and registry pull request"
        />
        <span>
          I confirm this exact destination, base commit, fork branch, files, version, and notes.
        </span>
      </label>
      <Button type="button" disabled={!confirmed || disabled} onClick={onSubmit}>
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {pending ? "Creating registry pull request…" : "Create registry pull request"}
      </Button>
    </div>
  );
}

function RegistryDetail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono">{value}</dd>
    </>
  );
}

function RegistrySubmissionResult({
  result,
}: {
  result: PublicationRegistryResult;
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-[var(--acc-green)]/30 bg-[var(--acc-green)]/5 p-3"
    >
      <p className="flex items-center gap-2 font-medium text-[var(--acc-green)]">
        <CheckCircle2 className="size-4" aria-hidden />
        Registry pull request {result.reused ? "reused" : "created"} (#{result.pull_request_number})
      </p>
      <p className="text-xs text-muted-foreground">
        Branch: <span className="font-mono">{result.branch}</span>. Await registry review; this is
        not acceptance, merge, or publication.
      </p>
      <Button
        type="button"
        variant="link"
        className="h-auto justify-start whitespace-normal break-all p-0"
        onClick={() =>
          void openExternalUrl(result.pull_request_url, "Could not open the registry pull request.")
        }
      >
        {result.pull_request_url} <ExternalLink className="size-3" aria-hidden />
      </Button>
    </div>
  );
}

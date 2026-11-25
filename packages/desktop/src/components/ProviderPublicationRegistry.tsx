import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { publicationBundles, useRefreshPublicationJournal } from "./PublicationRequest";
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
  onOperationChange,
}: {
  projectId: number;
  preview: PublicationReleasePreview;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onOperationChange?: (operationId: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const [plan, setPlan] = useState<PublicationRegistryPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<PublicationRegistryResult | null>(null);
  const previewMutation = usePreviewPublicationRegistry({
    mutation: {
      onSuccess: (value) => setPlan(value),
      onSettled: () => onPendingChange(false),
    },
  });
  const refreshJournal = useRefreshPublicationJournal(projectId);
  const submitMutation = useSubmitPublicationRegistry({
    mutation: {
      onSuccess: (value) => setResult(value),
      onMutate: refreshJournal,
      onSettled: () => {
        onPendingChange(false);
        refreshJournal();
      },
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
      data: registryPreviewRequest(preview),
    });
  };
  const submit = (): void => {
    if (!plan || !confirmed || disabled || pending) return;
    setConfirmed(false);
    setResult(null);
    submitMutation.reset();
    onPendingChange(true);
    onOperationChange?.(plan.operation_id);
    submitMutation.mutate({
      id: projectId,
      data: registrySubmissionRequest(plan),
    });
  };

  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <RegistryIntroduction />
      <RegistryReviewButton
        disabled={disabled || pending}
        reviewing={previewMutation.isPending}
        error={previewMutation.isError ? previewMutation.error : null}
        onReview={review}
      />
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
          prefix={t(
            "marketplace.publication.registry.submitFailed",
            "Could not submit the registry pull request",
          )}
          error={submitMutation.error}
        />
      ) : null}
      {submitMutation.isPending ? <RegistrySubmissionPending /> : null}
      {result ? <RegistrySubmissionResult result={result} /> : null}
    </div>
  );
}

function RegistryReviewButton({
  disabled,
  reviewing,
  error,
  onReview,
}: {
  disabled: boolean;
  reviewing: boolean;
  error: unknown;
  onReview: () => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <>
      <Button type="button" variant="outline" disabled={disabled} onClick={onReview}>
        {reviewing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {reviewing
          ? t("marketplace.publication.registry.reviewing", "Reviewing registry submission…")
          : t("marketplace.publication.registry.review", "Review registry submission")}
      </Button>
      {error ? (
        <PublicationError
          prefix={t(
            "marketplace.publication.registry.reviewFailed",
            "Could not review the registry submission",
          )}
          error={error}
        />
      ) : null}
    </>
  );
}

function RegistryIntroduction(): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div className="space-y-1">
      <p className="font-medium">
        {t("marketplace.publication.registry.title", "Submit to the Cadencr marketplace registry")}
      </p>
      <p className="text-xs text-muted-foreground">
        <UiTrans
          i18nKey="marketplace.publication.registry.reviewExplanation"
          defaults="Review a plan for <repository>{{repository}}</repository>, then separately confirm creation or reuse of your fork branch and pull request. This does not accept, merge, or publish the submission. A remote timeout may leave a fork or branch; Cadencr will not automatically retry writes."
          components={{ repository: <span className="font-mono" /> }}
          values={{ repository: "merkr-software/cadencr-registry" }}
        />
      </p>
    </div>
  );
}

function RegistrySubmissionPending(): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden />{" "}
      {t("marketplace.publication.registry.creating", "Creating registry pull request…")}
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
  const { t } = useUiTranslation();
  const rows: [string, string][] = [
    [t("marketplace.publication.destination", "Destination"), plan.registry_repository],
    [t("marketplace.publication.registry.account", "GitHub account"), plan.account],
    [
      t("marketplace.publication.registry.base", "Base"),
      `${plan.base_branch} @ ${plan.base_commit}`,
    ],
    [t("marketplace.publication.registry.forkBranch", "Fork branch"), plan.branch],
    [t("marketplace.publication.registry.packagePath", "Package path"), plan.package_path],
    [t("marketplace.publication.registry.submissionPath", "Submission path"), plan.submission_path],
    [t("marketplace.publication.registry.plugin", "Plugin"), plan.plugin_id],
    [t("marketplace.publication.version", "Version"), plan.version],
  ];
  return (
    <div className="space-y-3 rounded-lg border border-[var(--acc-orange)]/30 bg-[var(--acc-orange)]/5 p-3">
      <p className="font-medium">
        {t("marketplace.publication.registry.previewTitle", "Registry pull request preview")}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <RegistryDetail key={label} label={label} value={value} />
        ))}
        <dt className="text-muted-foreground">
          {t("marketplace.publication.releaseNotes", "Release notes")}
        </dt>
        <dd className="whitespace-pre-wrap break-words">{plan.release_notes}</dd>
      </dl>
      <label className="flex items-start gap-2">
        <Checkbox
          checked={confirmed}
          disabled={disabled}
          onCheckedChange={(checked) => onConfirmedChange(checked === true)}
          aria-label={t(
            "marketplace.publication.registry.confirmPullRequestLabel",
            "I confirm this exact fork, branch, and registry pull request",
          )}
        />
        <span>
          {t(
            "marketplace.publication.registry.confirmPullRequestDetail",
            "I confirm this exact destination, base commit, fork branch, files, version, and notes.",
          )}
        </span>
      </label>
      <Button type="button" disabled={!confirmed || disabled} onClick={onSubmit}>
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {pending
          ? t("marketplace.publication.registry.creating", "Creating registry pull request…")
          : t("marketplace.publication.registry.create", "Create registry pull request")}
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
  const { t } = useUiTranslation();
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-[var(--acc-green)]/30 bg-[var(--acc-green)]/5 p-3"
    >
      <p className="flex items-center gap-2 font-medium text-[var(--acc-green)]">
        <CheckCircle2 className="size-4" aria-hidden />
        {result.reused
          ? t(
              "marketplace.publication.registry.reused",
              "Registry pull request reused (#{{number}})",
              { number: result.pull_request_number },
            )
          : t(
              "marketplace.publication.registry.created",
              "Registry pull request created (#{{number}})",
              { number: result.pull_request_number },
            )}
      </p>
      <p className="text-xs text-muted-foreground">
        <UiTrans
          i18nKey="marketplace.publication.registry.awaitReview"
          defaults="Branch: <branch>{{branch}}</branch>. Await registry review; this is not acceptance, merge, or publication."
          components={{ branch: <span className="font-mono" /> }}
          values={{ branch: result.branch }}
        />
      </p>
      <Button
        type="button"
        variant="link"
        className="h-auto justify-start whitespace-normal break-all p-0"
        onClick={() =>
          void openExternalUrl(
            result.pull_request_url,
            t(
              "marketplace.publication.registry.openFailed",
              "Could not open the registry pull request.",
            ),
          )
        }
      >
        {result.pull_request_url} <ExternalLink className="size-3" aria-hidden />
      </Button>
    </div>
  );
}

function registryPreviewRequest(preview: PublicationReleasePreview) {
  return {
    ...publicationBundles(preview),
    release_notes: preview.release_notes,
  };
}

function registrySubmissionRequest(plan: PublicationRegistryPreview) {
  return {
    bundle_id: plan.bundle_id,
    bundle_ids: plan.bundle_ids,
    release_notes: plan.release_notes,
    expected_plan_sha256: plan.plan_sha256,
    confirmed: true,
    operation_id: plan.operation_id,
  };
}

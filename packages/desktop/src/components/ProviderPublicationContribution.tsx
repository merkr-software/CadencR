import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { publicationBundles } from "./PublicationRequest";
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
  const { t } = useUiTranslation();
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
        ...publicationBundles(preview),
        release_notes: preview.release_notes,
        expected_plan_sha256: preview.plan_sha256,
        confirmed: true,
      },
    });
  };

  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <div className="space-y-1">
        <p className="font-medium">
          {t("marketplace.publication.contribution.title", "Prepare a local registry contribution")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(
            "marketplace.publication.contribution.description",
            "This verifies the exact GitHub release is already published, then writes contribution files locally. It does not submit a pull request, obtain registry acceptance, or sign the contribution. Missing or draft releases are not published automatically.",
          )}
        </p>
      </div>
      <label className="flex items-start gap-2">
        <Checkbox
          checked={confirmed}
          disabled={disabled || mutation.isPending}
          onCheckedChange={(checked) => setConfirmed(checked === true)}
          aria-label={t(
            "marketplace.publication.contribution.confirmLocalFilesLabel",
            "I confirm local file creation and read-only GitHub verification",
          )}
        />
        <span>
          {t(
            "marketplace.publication.contribution.confirmLocalFilesDetail",
            "I confirm local file creation and read-only GitHub verification for this exact preview.",
          )}
        </span>
      </label>
      <Button
        type="button"
        variant="outline"
        disabled={!confirmed || disabled || mutation.isPending}
        onClick={prepare}
      >
        {mutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {mutation.isPending
          ? t("marketplace.publication.contribution.preparing", "Preparing registry contribution…")
          : t("marketplace.publication.contribution.prepare", "Prepare registry contribution")}
      </Button>
      {mutation.isError ? (
        <PublicationError
          prefix={t(
            "marketplace.publication.contribution.prepareFailed",
            "Could not prepare the registry contribution",
          )}
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
  const { t } = useUiTranslation();
  return (
    <div
      role="status"
      className="space-y-3 rounded-lg border border-[var(--acc-green)]/30 bg-[var(--acc-green)]/5 p-3"
    >
      <p className="flex items-center gap-2 font-medium text-[var(--acc-green)]">
        <CheckCircle2 className="size-4" aria-hidden />{" "}
        {t("marketplace.publication.contribution.prepared", "Local contribution files prepared")}
      </p>
      <dl className="space-y-2 text-xs">
        <PathDetail
          label={t("marketplace.publication.contribution.outputDirectory", "Output directory")}
          path={prepared.output_directory}
          reveal
        />
        <PathDetail
          label={t("marketplace.publication.contribution.packageMetadata", "Package metadata")}
          path={prepared.package_path}
        />
        <PathDetail
          label={t(
            "marketplace.publication.contribution.submissionMetadata",
            "Submission metadata",
          )}
          path={prepared.submission_path}
        />
        <PathDetail
          label={t(
            "marketplace.publication.contribution.pullRequestInstructions",
            "Pull request instructions",
          )}
          path={prepared.pull_request_path}
        />
      </dl>
      <p className="text-xs text-muted-foreground">
        {t(
          "marketplace.publication.contribution.localFilesNotice",
          "Local files only. No pull request was submitted, accepted, or signed.",
        )}
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
  const { t, i18n } = useUiTranslation();
  const [revealPending, setRevealPending] = useState(false);
  const revealPath = async (): Promise<void> => {
    setRevealPending(true);
    try {
      await desktopBridge.revealInFinder(path);
    } catch (error) {
      toastError(
        error,
        translateUi(
          "marketplace.publication.contribution.revealFailed",
          "Could not reveal the contribution files.",
        ),
      );
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
          aria-label={t("marketplace.publication.contribution.copyPath", "Copy {{label}}", {
            label: label.toLocaleLowerCase(i18n.resolvedLanguage),
          })}
          onClick={() =>
            void copyToClipboard(
              path,
              t("marketplace.publication.contribution.pathCopied", "{{label}} copied", { label }),
            )
          }
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
              revealPending
                ? t(
                    "marketplace.publication.contribution.revealingFiles",
                    "Revealing contribution files",
                  )
                : t("marketplace.publication.contribution.revealFiles", "Reveal contribution files")
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

import { useUiTranslation } from "@/lib/i18n/ui";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { type PublicationReleasePreview } from "@/api/generated";
import { useReleaseCandidate } from "./ProviderPublicationReleaseCandidate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ProviderPublicationContribution } from "./ProviderPublicationContribution";
import { ProviderPublicationRegistry } from "./ProviderPublicationRegistry";
import { ReleaseOutcome } from "./PublicationReleaseOutcome";
import { PublicationError } from "./PublicationError";
import { PublicationPreview } from "./PublicationReleasePreview";

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
  pluginKind?: "provider" | "theme" | "tab";
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
      <ReviewReleaseButton
        disabled={!validInput || pending}
        reviewing={previewMutation.isPending}
        error={previewMutation.isError ? previewMutation.error : null}
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
      {error ? (
        <PublicationError
          prefix={t(
            "marketplace.publication.release.reviewFailed",
            "Could not review the GitHub publication",
          )}
          error={error}
        />
      ) : null}
      <Button type="button" variant="outline" disabled={disabled} onClick={onReview}>
        {reviewing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {reviewing
          ? t("marketplace.publication.release.reviewing", "Reviewing GitHub publication…")
          : t("marketplace.publication.release.review", "Review GitHub publication")}
      </Button>
    </>
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
  pluginKind: "provider" | "theme" | "tab";
  additionalBundles: string;
  onAdditionalBundlesChange: (value: string) => void;
  bundleId: string;
  releaseNotes: string;
  disabled: boolean;
  onBundleIdChange: (value: string) => void;
  onReleaseNotesChange: (value: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <>
      <div className="space-y-1">
        <h4 className="text-sm font-medium">
          {t("marketplace.publication.release.title", "Publish the prepared bundle to GitHub")}
        </h4>
        <p className="text-xs text-muted-foreground">
          {t(
            "marketplace.publication.release.prerequisites",
            "Requires a configured GitHub connection, an existing public repository, and a clean local HEAD whose origin and already-pushed tag match the archive URL. Cadencr will not push source, create a tag, or submit to a registry.",
          )}
        </p>
      </div>
      <fieldset disabled={disabled} className="space-y-4 disabled:opacity-60">
        <label className="block space-y-1.5 text-sm font-medium">
          {t("marketplace.publication.release.bundleId", "Prepared bundle UUID")}
          <Input
            value={bundleId}
            onChange={(event) => onBundleIdChange(event.target.value)}
            placeholder="00000000-0000-4000-8000-000000000000"
          />
          <span className="block text-xs font-normal text-muted-foreground">
            {t(
              "marketplace.publication.release.bundlePlaceholder",
              "Filled from the prepared archive when available. For a restart or retry, paste the UUID from its parent folder; arbitrary archive paths are not accepted.",
            )}
          </span>
        </label>
        {pluginKind === "provider" && (
          <label className="block space-y-1.5 text-sm font-medium">
            {t("marketplace.publication.release.otherBundleIds", "Other platform bundle UUIDs")}
            <Textarea
              value={additionalBundles}
              onChange={(event) => onAdditionalBundlesChange(event.target.value)}
              placeholder={t(
                "marketplace.publication.release.otherBundleIdsPlaceholder",
                "One UUID per platform, separated by spaces or commas",
              )}
            />
            <span className="block text-xs font-normal text-muted-foreground">
              {t(
                "marketplace.publication.release.otherBundleIdsHelp",
                "Prepare each declared platform first. All bundles form one immutable version with one manifest.",
              )}
            </span>
          </label>
        )}
        <label className="block space-y-1.5 text-sm font-medium">
          {t("marketplace.publication.releaseNotes", "Release notes")}
          <Textarea
            value={releaseNotes}
            onChange={(event) => onReleaseNotesChange(event.target.value)}
            placeholder={t(
              "marketplace.publication.release.notesPlaceholder",
              "Describe this release for its GitHub release page",
            )}
            className="min-h-24"
          />
        </label>
      </fieldset>
    </>
  );
}

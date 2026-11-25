import { useUiTranslation } from "@/lib/i18n/ui";
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
import { PublicationError } from "./PublicationError";
import { bundleIdFromArchivePath, ProviderPublicationRelease } from "./ProviderPublicationRelease";

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
    <ProviderPackageSection>
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
      <PackagePreparationFooter
        projectId={projectId}
        prepared={prepared}
        pending={pending}
        error={mutation.isError ? mutation.error : null}
        canPrepare={canPrepare}
        onPrepare={prepare}
      />
    </ProviderPackageSection>
  );
}

function ProviderPackageSection({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <SettingsSection
      size="sm"
      title={t("marketplace.publication.providerPackage.title", "Prepare a local provider bundle")}
      subtitle={t(
        "marketplace.publication.providerPackage.localFileCreation",
        "Explicit local file creation",
      )}
      description={t(
        "marketplace.publication.providerPackage.description",
        "Create an archive and managed package.json in a new app-owned folder. This action writes files, unlike the read-only checks above.",
      )}
    >
      <SettingsCard padded>
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {t(
              "marketplace.publication.providerPackage.localBundleNotice",
              "Your input and repository remain unchanged. This does not run the connector, publish to GitHub, create a release, submit anywhere, or approve conformance.",
            )}
          </p>
          {children}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

function PackagePreparationFooter({
  projectId,
  prepared,
  pending,
  error,
  canPrepare,
  onPrepare,
}: {
  projectId: number;
  prepared: PreparedPublicationPackage | null;
  pending: boolean;
  error: unknown;
  canPrepare: boolean;
  onPrepare: () => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <>
      {error ? (
        <PublicationError
          prefix={t(
            "marketplace.publication.providerPackage.prepareError",
            "Could not prepare the local bundle",
          )}
          error={error}
        />
      ) : null}
      {prepared ? <PreparedPackageResult prepared={prepared} /> : null}
      <Button type="button" disabled={!canPrepare || pending} onClick={onPrepare}>
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {pending
          ? t("marketplace.publication.providerPackage.preparing", "Preparing local bundle…")
          : t("marketplace.publication.providerPackage.prepare", "Prepare local bundle")}
      </Button>
      <ProviderPublicationRelease
        key={prepared?.archive_path ?? "publication-release"}
        projectId={projectId}
        initialBundleId={prepared ? bundleIdFromArchivePath(prepared.archive_path) : ""}
      />
    </>
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
  const { t } = useUiTranslation();
  if (loading) {
    return (
      <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />{" "}
        {t("marketplace.publication.providerPackage.loadingTargets", "Loading supported targets…")}
      </div>
    );
  }
  const message = error
    ? t(
        "marketplace.publication.providerPackage.targetsError",
        "Could not load supported package targets: {{error}}",
        {
          error: apiErrorMessage(error, t("common.unknownError", "Unknown error")),
        },
      )
    : hasTargets
      ? t(
          "marketplace.publication.providerPackage.targetsNotReady",
          "Supported package targets are not ready.",
        )
      : t(
          "marketplace.publication.providerPackage.noTargets",
          "No supported package targets were returned. Refresh the read-only checks and try again.",
        );
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
  const { t } = useUiTranslation();
  return (
    <fieldset disabled={props.disabled} className="space-y-4 disabled:opacity-60">
      <label className="block space-y-1.5 text-sm font-medium">
        {t("marketplace.publication.providerPackage.metadataJson", "Managed package metadata JSON")}
        <Textarea
          value={props.metadataJson}
          onChange={(event) => props.onMetadataChange(event.target.value)}
          placeholder={t(
            "marketplace.publication.providerPackage.metadataPlaceholder",
            "Paste the existing author-provided managed package JSON",
          )}
          className="min-h-32 font-mono text-xs"
        />
        <span className="block text-xs font-normal text-muted-foreground">
          {t(
            "marketplace.publication.providerPackage.metadataHelp",
            "Use the existing managed package JSON, not a host descriptor. Cadencr does not guess publisher, version, or URLs. Declare every release target; the selected target URL must end in .tar.gz or .tgz.",
          )}
        </span>
      </label>
      <label className="block space-y-1.5 text-sm font-medium">
        {t(
          "marketplace.publication.providerPackage.stagingDirectory",
          "Dedicated staging directory",
        )}
        <Input
          value={props.stagingDirectory}
          onChange={(event) => props.onStagingChange(event.target.value)}
          placeholder="/absolute/path/to/reviewed-staging"
        />
        <span className="block text-xs font-normal text-muted-foreground">
          {t(
            "marketplace.publication.providerPackage.stagingDirectoryHelp",
            "Choose an absolute, dedicated, reviewed, quiescent directory outside the project tree. Do not select the home directory itself or include credentials.",
          )}
        </span>
      </label>
      <div className="space-y-1.5 text-sm font-medium">
        <label id="publication-binary-target-label">
          {t("marketplace.publication.providerPackage.binaryTarget", "Binary target")}
        </label>
        <Select value={props.target} onValueChange={props.onTargetChange} disabled={props.disabled}>
          <SelectTrigger className="w-full" aria-labelledby="publication-binary-target-label">
            <SelectValue
              placeholder={t(
                "marketplace.publication.providerPackage.targetPlaceholder",
                "Select one declared target",
              )}
            />
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
          aria-label={t(
            "marketplace.publication.providerPackage.stagingReviewedLabel",
            "I reviewed staging and excluded credentials",
          )}
        />
        <span>
          {t(
            "marketplace.publication.providerPackage.stagingReviewedDetail",
            "I reviewed staging and excluded credentials.",
          )}
        </span>
      </label>
    </fieldset>
  );
}

function PreparedPackageResult({
  prepared,
}: {
  prepared: PreparedPublicationPackage;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-[var(--acc-green)]/30 bg-[var(--acc-green)]/5 p-3 text-sm"
    >
      <p className="flex items-center gap-2 font-medium text-[var(--acc-green)]">
        <CheckCircle2 className="size-4" aria-hidden />{" "}
        {t("marketplace.publication.providerPackage.localBundlePrepared", "Local bundle prepared")}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">
          {t("marketplace.publication.providerPackage.archive", "Archive")}
        </dt>
        <dd className="break-all font-mono">{prepared.archive_path}</dd>
        <dt className="text-muted-foreground">
          {t("marketplace.publication.providerPackage.metadata", "Metadata")}
        </dt>
        <dd className="break-all font-mono">{prepared.metadata_path}</dd>
        <dt className="text-muted-foreground">
          {t("marketplace.publication.providerPackage.sha256", "SHA-256")}
        </dt>
        <dd className="break-all font-mono">{prepared.sha256}</dd>
        <dt className="text-muted-foreground">
          {t("marketplace.publication.providerPackage.size", "Size")}
        </dt>
        <dd>
          {t("marketplace.publication.byteCount", "{{count, number}} bytes", {
            count: prepared.size,
            defaultValue_zero: "{{count, number}} bytes",
            defaultValue_one: "{{count, number}} byte",
          })}
        </dd>
        <dt className="text-muted-foreground">
          {t("marketplace.publication.providerPackage.target", "Target")}
        </dt>
        <dd className="font-mono">{prepared.target}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        {t(
          "marketplace.publication.providerPackage.localResultNotice",
          "Local files only; nothing was published or approved.",
        )}
      </p>
    </div>
  );
}

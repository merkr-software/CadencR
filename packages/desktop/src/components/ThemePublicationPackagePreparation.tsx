import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
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
  const { t } = useUiTranslation();
  const isTab = pluginKind === "tab";
  const labels = packageLabels(pluginKind, t);
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
    <SettingsSection size="sm" title={labels.title} subtitle={labels.subtitle}>
      <SettingsCard padded>
        <div className="space-y-4">
          <BundleDescription isTab={isTab} />
          {readiness.isLoading && <p role="status">{labels.checking}</p>}
          {readiness.isError && (
            <PublicationError prefix={labels.checkFailed} error={readiness.error} />
          )}
          <label className="block space-y-1.5 text-sm font-medium">
            {labels.metadata}
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
              {t(
                "marketplace.publication.portablePackage.metadataHelp",
                "Declare identity, version, publisher, repository, compatibility and the single archive URL. No platform target is needed.",
              )}
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={reviewed}
              disabled={prepare.isPending}
              aria-label={labels.reviewed}
              onCheckedChange={(value) => {
                setReviewed(value === true);
                invalidate();
              }}
            />
            {labels.reviewedSentence}
          </label>
          {prepare.isError && (
            <PublicationError prefix={labels.prepareFailed} error={prepare.error} />
          )}
          {prepared && <PreparedBundleResult prepared={prepared} status={labels.prepared} />}
          <Button
            disabled={!canPrepare || prepare.isPending}
            onClick={() => prepare.mutate({ id: projectId, data: { metadata_json: metadata } })}
          >
            {prepare.isPending ? labels.preparing : labels.prepare}
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
  const { t } = useUiTranslation();
  return (
    <p className="text-xs text-muted-foreground">
      {isTab
        ? t(
            "marketplace.publication.portablePackage.tabDescription",
            "Cadencr snapshots tab.json, the declared icon and the compiled web directory. Build the tab first; sources, node_modules and Git history are excluded. Installed tabs require consent before activation.",
          )
        : t(
            "marketplace.publication.portablePackage.themeDescription",
            "Cadencr snapshots only validated theme.json and its declared raster asset from this author project. Git history, scaffolding and other files are excluded. No executable, command or ACP runtime is included.",
          )}
    </p>
  );
}

function PreparedBundleResult({
  prepared,
  status,
}: {
  prepared: PreparedPublicationPackage;
  status: string;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div role="status" className="space-y-1 rounded border p-3 text-xs">
      <p>{status}</p>
      <p className="break-all font-mono">{prepared.archive_path}</p>
      <p className="break-all font-mono">
        {t("marketplace.publication.sha256Value", "SHA-256: {{hash}}", { hash: prepared.sha256 })}
      </p>
      <p>
        {t("marketplace.publication.byteCount", "{{count, number}} bytes", {
          count: prepared.size,
          defaultValue_zero: "{{count, number}} bytes",
          defaultValue_one: "{{count, number}} byte",
        })}
      </p>
    </div>
  );
}

function packageLabels(kind: "tab" | "theme", t: UiTranslator) {
  return kind === "tab"
    ? {
        title: t(
          "marketplace.publication.portablePackage.tab.title",
          "Prepare a custom tab bundle",
        ),
        subtitle: t(
          "marketplace.publication.portablePackage.tab.subtitle",
          "Compiled web interface and manifest",
        ),
        checking: t(
          "marketplace.publication.portablePackage.tab.checking",
          "Checking custom tab project…",
        ),
        checkFailed: t(
          "marketplace.publication.portablePackage.tab.checkFailed",
          "Could not check the custom tab project",
        ),
        metadata: t(
          "marketplace.publication.portablePackage.tab.metadata",
          "Custom tab package metadata JSON",
        ),
        reviewed: t(
          "marketplace.publication.portablePackage.tab.reviewed",
          "I reviewed the custom tab data and metadata",
        ),
        reviewedSentence: t(
          "marketplace.publication.portablePackage.tab.reviewedSentence",
          "I reviewed the custom tab data and metadata.",
        ),
        prepareFailed: t(
          "marketplace.publication.portablePackage.tab.prepareFailed",
          "Could not prepare the custom tab bundle",
        ),
        prepared: t(
          "marketplace.publication.portablePackage.tab.prepared",
          "Custom tab bundle prepared; nothing published.",
        ),
        preparing: t(
          "marketplace.publication.portablePackage.tab.preparing",
          "Preparing custom tab bundle…",
        ),
        prepare: t(
          "marketplace.publication.portablePackage.tab.prepare",
          "Prepare custom tab bundle",
        ),
      }
    : {
        title: t(
          "marketplace.publication.portablePackage.theme.title",
          "Prepare a declarative theme bundle",
        ),
        subtitle: t(
          "marketplace.publication.portablePackage.theme.subtitle",
          "Platform-independent data only",
        ),
        checking: t(
          "marketplace.publication.portablePackage.theme.checking",
          "Checking theme project…",
        ),
        checkFailed: t(
          "marketplace.publication.portablePackage.theme.checkFailed",
          "Could not check the theme project",
        ),
        metadata: t(
          "marketplace.publication.portablePackage.theme.metadata",
          "Theme package metadata JSON",
        ),
        reviewed: t(
          "marketplace.publication.portablePackage.theme.reviewed",
          "I reviewed the theme data and metadata",
        ),
        reviewedSentence: t(
          "marketplace.publication.portablePackage.theme.reviewedSentence",
          "I reviewed the theme data and metadata.",
        ),
        prepareFailed: t(
          "marketplace.publication.portablePackage.theme.prepareFailed",
          "Could not prepare the theme bundle",
        ),
        prepared: t(
          "marketplace.publication.portablePackage.theme.prepared",
          "Declarative theme bundle prepared; nothing published.",
        ),
        preparing: t(
          "marketplace.publication.portablePackage.theme.preparing",
          "Preparing theme bundle…",
        ),
        prepare: t("marketplace.publication.portablePackage.theme.prepare", "Prepare theme bundle"),
      };
}

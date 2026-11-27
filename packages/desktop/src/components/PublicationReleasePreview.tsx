import { Loader2 } from "lucide-react";
import type { PublicationReleasePreview } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";

export function PublicationPreview({
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
  const { t } = useUiTranslation();
  const rows = releaseFacts(preview, t);
  return (
    <div className="space-y-3 rounded-lg border border-[var(--acc-orange)]/30 bg-[var(--acc-orange)]/5 p-3 text-sm">
      <p className="font-medium">
        {t("marketplace.publication.release.previewTitle", "GitHub publication preview")}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <ReleaseDetail key={label} label={label} value={value} />
        ))}
        <dt className="text-muted-foreground">
          {t("marketplace.publication.releaseNotes", "Release notes")}
        </dt>
        <dd className="whitespace-pre-wrap break-words">{preview.release_notes}</dd>
      </dl>
      {preview.archives?.map((archive) => (
        <div key={archive.bundle_id} className="rounded border p-2 text-xs font-mono break-all">
          {archive.target ||
            t(
              "marketplace.publication.release.portablePackage",
              "Platform-independent package",
            )}{" "}
          · {archive.archive_name} ·{" "}
          {t("marketplace.publication.byteCount", "{{count, number}} bytes", {
            count: archive.archive_size,
            defaultValue_zero: "{{count, number}} bytes",
            defaultValue_one: "{{count, number}} byte",
          })}
          <div>
            {t("marketplace.publication.sha256Value", "SHA-256: {{hash}}", {
              hash: archive.archive_sha256,
            })}
          </div>
        </div>
      ))}
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={confirmed}
          disabled={pending}
          onCheckedChange={(checked) => onConfirmedChange(checked === true)}
          aria-label={t(
            "marketplace.publication.release.confirmPublicationLabel",
            "I confirm this exact GitHub publication",
          )}
        />
        <span>
          {t(
            "marketplace.publication.release.confirmPublicationDetail",
            "I confirm this exact destination, actor, tag, source, all package archives, manifest, version, and notes.",
          )}
        </span>
      </label>
      <Button type="button" disabled={!confirmed || pending} onClick={onPublish}>
        {publishing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {publishing
          ? t("marketplace.publication.release.publishing", "Publishing GitHub release…")
          : t("marketplace.publication.release.publish", "Publish GitHub release")}
      </Button>
    </div>
  );
}

function releaseFacts(preview: PublicationReleasePreview, t: UiTranslator): [string, string][] {
  return [
    [t("marketplace.publication.destination", "Destination"), preview.repository],
    [t("marketplace.publication.release.actor", "Actor"), preview.account],
    [t("marketplace.publication.release.tag", "Tag"), preview.tag],
    [t("marketplace.publication.release.sourceCommit", "Source commit"), preview.source_commit],
    [t("marketplace.publication.release.archiveSha256", "Archive SHA-256"), preview.archive_sha256],
    [t("marketplace.publication.release.archiveFile", "Archive file"), preview.archive_name],
    [
      t("marketplace.publication.release.archiveSize", "Archive size"),
      t("marketplace.publication.byteCount", "{{count, number}} bytes", {
        count: preview.archive_size,
        defaultValue_zero: "{{count, number}} bytes",
        defaultValue_one: "{{count, number}} byte",
      }),
    ],
    [
      t("marketplace.publication.release.metadataSha256", "Metadata SHA-256"),
      preview.metadata_sha256,
    ],
    [
      t("marketplace.publication.release.content", "Content"),
      preview.target ||
        t("marketplace.publication.release.portablePackage", "Platform-independent package"),
    ],
    [t("marketplace.publication.version", "Version"), preview.version],
    [
      t("marketplace.publication.release.channel", "Release channel"),
      preview.prerelease
        ? t("marketplace.publication.release.prerelease", "Prerelease")
        : t("marketplace.publication.release.stable", "Stable"),
    ],
  ];
}

function ReleaseDetail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono">{value}</dd>
    </>
  );
}

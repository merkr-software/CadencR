import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import {
  useGetProjectPublicationReadiness,
  type PublicationReadinessResponse,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/lib/api-errors";

export function ProviderPublicationPreparation({
  projectId,
  enabled,
  pluginKind = "provider",
}: {
  projectId: number;
  enabled: boolean;
  pluginKind?: "provider" | "theme" | "tab";
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const readiness = useGetProjectPublicationReadiness(projectId, {
    query: { enabled },
  });

  return (
    <SettingsSection
      size="sm"
      title={
        pluginKind === "tab"
          ? t("marketplace.publication.readiness.tabTitle", "Custom tab publication preparation")
          : pluginKind === "theme"
            ? t("marketplace.publication.readiness.themeTitle", "Theme publication preparation")
            : t(
                "marketplace.publication.readiness.providerTitle",
                "Provider publication preparation",
              )
      }
      subtitle={t("marketplace.publication.readiness.localChecksOnly", "Local checks only")}
      description={readinessDescription(pluginKind, t)}
    >
      <SettingsCard padded>
        <div className="space-y-4" aria-live="polite">
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">
              {t(
                "marketplace.publication.readiness.readOnlyChecks",
                "Cadencr checks the current files without changing the repository or contacting GitHub.",
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={readiness.isLoading || readiness.isRefetching}
              onClick={() => void readiness.refetch()}
            >
              {readiness.isRefetching ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden />
              )}
              {t("marketplace.publication.readiness.refresh", "Refresh checks")}
            </Button>
          </div>

          {readiness.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("marketplace.publication.readiness.checking", "Checking local prerequisites…")}
            </div>
          ) : readiness.isError ? (
            <div
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              {t(
                "marketplace.publication.readiness.checkFailed",
                "Could not check local prerequisites: {{error}}",
                {
                  error: apiErrorMessage(
                    readiness.error,
                    t("common.unknownError", "Unknown error"),
                  ),
                },
              )}
            </div>
          ) : readiness.data ? (
            <ReadinessResult readiness={readiness.data} pluginKind={pluginKind} />
          ) : null}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

type PublicationKind = "provider" | "theme" | "tab";

function readinessDescription(kind: PublicationKind, t: UiTranslator): string {
  switch (kind) {
    case "tab":
      return t(
        "marketplace.publication.readiness.tabDescription",
        "Review local tab prerequisites. This does not publish to GitHub, create a release, or submit to a registry.",
      );
    case "theme":
      return t(
        "marketplace.publication.readiness.themeDescription",
        "Review local theme prerequisites. This does not publish to GitHub, create a release, or submit to a registry.",
      );
    case "provider":
      return t(
        "marketplace.publication.readiness.providerDescription",
        "Review local provider prerequisites. This does not publish to GitHub, create a release, or submit to a registry.",
      );
  }
}

function ReadinessResult({
  readiness,
  pluginKind,
}: {
  readiness: PublicationReadinessResponse;
  pluginKind: PublicationKind;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const prepared = readiness.local_preparation === "prepared";
  const hasWarnings = readiness.checks.some((check) => check.status === "warning");
  const allPass = prepared && !hasWarnings;
  const statusLabels = {
    pass: t("marketplace.publication.readiness.checkPassed", "pass"),
    warning: t("marketplace.publication.readiness.checkWarning", "warning"),
    fail: t("marketplace.publication.readiness.checkFailedStatus", "fail"),
  };

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "flex items-start gap-2 rounded-lg border p-3 text-sm",
          allPass
            ? "border-[var(--acc-green)]/30 bg-[var(--acc-green)]/5 text-[var(--acc-green)]"
            : "border-[var(--acc-orange)]/30 bg-[var(--acc-orange)]/5 text-[var(--acc-orange)]",
        )}
        role="status"
      >
        {allPass ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        ) : (
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        )}
        <div>
          <p className="font-medium">
            {allPass
              ? t(
                  "marketplace.publication.readiness.checksPass",
                  "All local preparation checks pass",
                )
              : prepared
                ? t(
                    "marketplace.publication.readiness.noBlockingIssues",
                    "No blocking local issues found",
                  )
                : t("marketplace.publication.readiness.blocked", "Local preparation is blocked")}
          </p>
          <p className="mt-0.5 text-xs opacity-90">{readinessSummary(pluginKind, prepared, t)}</p>
        </div>
      </div>

      <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
        {readiness.checks.map((check) => {
          const Icon =
            check.status === "pass"
              ? CheckCircle2
              : check.status === "fail"
                ? XCircle
                : AlertTriangle;
          return (
            <li key={check.id} className="flex items-start gap-3 px-3 py-2.5">
              <Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  check.status === "pass" && "text-[var(--acc-green)]",
                  check.status === "warning" && "text-[var(--acc-orange)]",
                  check.status === "fail" && "text-[var(--acc-red)]",
                )}
                aria-hidden
              />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  <span className="sr-only">
                    {t("marketplace.publication.readiness.statusPrefix", "{{status}}: ", {
                      status: statusLabels[check.status],
                    })}
                  </span>
                  {readinessCheckLabel(check, t)}
                </p>
                <p className="text-xs text-muted-foreground">{check.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-[11px] text-muted-foreground">
        {t(
          "marketplace.publication.readiness.checksScope",
          "Passing these checks does not mean the plugin is published or fully release-ready.",
        )}
      </p>
    </div>
  );
}

function readinessSummary(kind: PublicationKind, prepared: boolean, t: UiTranslator): string {
  switch (kind) {
    case "tab":
      return t(
        "marketplace.publication.readiness.tabSummary",
        "Custom tab publication requires a validated manifest, compiled web output, source release, and registry verification. Local checks do not publish anything.",
      );
    case "theme":
      return prepared
        ? t(
            "marketplace.publication.readiness.themePrepared",
            "No blocking local issues found. This is not publication approval: closed declarative packaging, source-release, maintainer, and registry verification remain.",
          )
        : t(
            "marketplace.publication.readiness.themeBlocked",
            "Local theme preparation has blocking issues. Strict declarative document and raster validation, source-release, maintainer, and registry verification are required.",
          );
    case "provider":
      return prepared
        ? t(
            "marketplace.publication.readiness.providerPrepared",
            "No blocking local issues found. This is not release or publication approval: packaging, connector conformance, source-release, maintainer, and registry verification remain.",
          )
        : t(
            "marketplace.publication.readiness.providerBlocked",
            "Local package preparation has blocking issues. Passing these checks still requires packaging, connector conformance, source-release, maintainer, and registry verification.",
          );
  }
}

function readinessCheckLabel(
  check: PublicationReadinessResponse["checks"][number],
  t: UiTranslator,
): string {
  switch (check.id) {
    case "tab-build":
      return t("marketplace.publication.readiness.checks.tab", "Compiled custom tab");
    case "theme-document":
      return t("marketplace.publication.readiness.checks.theme", "Declarative theme");
    case "workspace_identity":
      return t("marketplace.publication.readiness.checks.workspaceIdentity", "Workspace identity");
    case "host_descriptor":
      return t("marketplace.publication.readiness.checks.hostDescriptor", "Host descriptor");
    case "repository":
      return t("marketplace.publication.readiness.checks.repository", "Source repository");
    case "license_metadata":
      return t("marketplace.publication.readiness.checks.licenseMetadata", "License metadata");
    case "distribution":
      return t("marketplace.publication.readiness.checks.distribution", "Binary distribution");
    case "license_file":
      return t("marketplace.publication.readiness.checks.licenseFile", "License file");
    case "icon":
      return t("marketplace.publication.readiness.checks.icon", "Provider icon");
    case "executable":
      return t("marketplace.publication.readiness.checks.executable", "Provider executable");
    case "git_root":
      return t("marketplace.publication.readiness.checks.gitRoot", "Git repository");
    case "git_head":
      return t("marketplace.publication.readiness.checks.gitHead", "Git revision");
    case "git_clean":
      return t("marketplace.publication.readiness.checks.gitWorktree", "Git worktree");
    default:
      return check.label;
  }
}

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
}: {
  projectId: number;
  enabled: boolean;
}): React.JSX.Element {
  const readiness = useGetProjectPublicationReadiness(projectId, {
    query: { enabled },
  });

  return (
    <SettingsSection
      size="sm"
      title="Provider publication preparation"
      subtitle="Local checks only"
      description="Review local provider prerequisites. This does not publish to GitHub, create a release, or submit to a registry."
    >
      <SettingsCard padded>
        <div className="space-y-4" aria-live="polite">
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">
              Cadencr checks the current files without changing the repository or contacting GitHub.
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
              Refresh checks
            </Button>
          </div>

          {readiness.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Checking local prerequisites…
            </div>
          ) : readiness.isError ? (
            <div
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              role="alert"
            >
              Could not check local prerequisites:{" "}
              {apiErrorMessage(readiness.error, "Unknown error")}
            </div>
          ) : readiness.data ? (
            <ReadinessResult readiness={readiness.data} />
          ) : null}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

function ReadinessResult({
  readiness,
}: {
  readiness: PublicationReadinessResponse;
}): React.JSX.Element {
  const prepared = readiness.local_preparation === "prepared";
  const hasWarnings = readiness.checks.some((check) => check.status === "warning");
  const allPass = prepared && !hasWarnings;

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
              ? "All local preparation checks pass"
              : prepared
                ? "No blocking local issues found"
                : "Local preparation is blocked"}
          </p>
          <p className="mt-0.5 text-xs opacity-90">{readiness.summary}</p>
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
                  <span className="sr-only">{check.status}: </span>
                  {check.label}
                </p>
                <p className="text-xs text-muted-foreground">{check.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-[11px] text-muted-foreground">
        Passing these checks does not mean the provider is published or fully release-ready.
      </p>
    </div>
  );
}

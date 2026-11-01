import { CircleAlert } from "lucide-react";
import type { ExtensionCliError, ExtensionCliSummary } from "@/api/generated";
import { cliLabel } from "@/lib/agent-extensions";
import { apiErrorMessage } from "@/lib/api-errors";
import { CheckCatalogButton, MarketplaceEmpty } from "../MarketplaceStates";

/** CLIs that could not answer; the others' results still show. */
export function CliErrors({
  errors,
  clis,
}: {
  errors: ExtensionCliError[] | undefined;
  clis: ExtensionCliSummary[];
}): React.JSX.Element | null {
  if (!errors?.length) return null;
  return (
    <div
      role="alert"
      className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2"
    >
      {/* One CLI can report twice: a failed marketplace refresh, then a failed listing. */}
      {errors.map((error, index) => (
        <p key={index} className="flex gap-2 text-xs text-destructive">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="font-medium">{cliLabel(clis, error.provider_id)}:</span>{" "}
            {error.message}
          </span>
        </p>
      ))}
    </div>
  );
}

/** A failed listing request, with its message and a way to retry. */
export function AgentLoadError({
  error,
  what,
  retrying,
  onRetry,
}: {
  error: unknown;
  what: string;
  retrying: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <MarketplaceEmpty
      icon={CircleAlert}
      title={`Could not load ${what}`}
      detail={apiErrorMessage(error, "The request failed.")}
      action={<CheckCatalogButton refreshing={retrying} onRefresh={onRetry} label="Try again" />}
    />
  );
}

/** No agent CLI on this computer can carry this kind. */
export function NoCapableCli({ what }: { what: string }): React.JSX.Element {
  return (
    <MarketplaceEmpty
      icon={CircleAlert}
      title={`No agent CLI here can install ${what}`}
      detail="Install Claude Code or the Codex CLI on this computer, then come back."
    />
  );
}

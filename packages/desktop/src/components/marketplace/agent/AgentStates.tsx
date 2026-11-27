import { useUiTranslation } from "@/lib/i18n/ui";
import { CircleAlert } from "lucide-react";
import type { ExtensionCliError, ExtensionCliSummary } from "@/api/generated";
import { cliLabel, type AgentExtensionKind } from "@/lib/agent-extensions";
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
  title,
  retrying,
  onRetry,
}: {
  error: unknown;
  title: string;
  retrying: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <MarketplaceEmpty
      icon={CircleAlert}
      title={title}
      detail={apiErrorMessage(
        error,
        t("marketplace.agent.agentStates.requestFailed", "The request failed."),
      )}
      action={
        <CheckCatalogButton
          refreshing={retrying}
          onRefresh={onRetry}
          label={t("marketplace.agent.agentStates.tryAgain", "Try again")}
        />
      }
    />
  );
}

/** No agent CLI on this computer can carry this kind. */
export function NoCapableCli({ kind }: { kind: AgentExtensionKind }): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <MarketplaceEmpty
      icon={CircleAlert}
      title={
        kind === "skill"
          ? t("marketplace.agent.agentStates.noSkillCli", "No agent CLI here can install skills")
          : t("marketplace.agent.agentStates.noMcpCli", "No agent CLI here can install MCP servers")
      }
      detail={t(
        "marketplace.agent.agentStates.installCliHint",
        "Install Claude Code or the Codex CLI on this computer, then come back.",
      )}
    />
  );
}

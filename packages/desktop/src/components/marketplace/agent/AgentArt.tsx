import { memo } from "react";
import type { ExtensionCliSummary } from "@/api/generated";
import { ProviderIcon } from "@/lib/provider-icons";

/**
 * A skill or MCP server shown as what it is to an agent: the command a CLI
 * runs, and the CLIs that carry it now (filled) or could (faded).
 */
export const AgentArt = memo(function AgentArt({
  command,
  clis,
  carriedBy,
}: {
  command: string;
  clis: ExtensionCliSummary[];
  carriedBy: ReadonlySet<string>;
}): React.JSX.Element {
  return (
    <div className="mp-agent-art">
      <code className="mp-agent-command" title={command}>
        {command}
      </code>
      <div className="mp-agent-carriers" aria-hidden="true">
        {clis.map((cli) => {
          const carried = carriedBy.has(cli.provider_id);
          return (
            <span
              key={cli.provider_id}
              className="mp-agent-carrier"
              data-absent={carried ? undefined : ""}
              title={`${cli.label}: ${carried ? "installed" : "not installed"}`}
            >
              <ProviderIcon providerId={cli.provider_id} alt="" className="size-3.5" />
            </span>
          );
        })}
      </div>
    </div>
  );
});

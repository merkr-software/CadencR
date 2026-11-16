import { Globe, ShieldCheck } from "lucide-react";
import type { PluginTabSummary } from "@/api/generated";
import { describeScope } from "./custom-tab-model";
import { CustomTabExecution } from "./CustomTabExecution";
import { NewMark } from "./CustomTabUpdateChanges";
import type { AddedAccess } from "./update-changes";

/**
 * What a tab may read, which sites it may reach and what it may run, in plain
 * words. The same list the consent dialog asks the user to accept, so the
 * card and the dialog never describe one permission two ways. Reviewing an
 * update, `added` marks what the installed version did not ask for.
 */
export function CustomTabPermissions({
  tab,
  added,
}: {
  tab: Pick<PluginTabSummary, "permissions" | "network" | "commands" | "backend">;
  added?: AddedAccess;
}): React.JSX.Element {
  const origins = tab.network.allowed_origins;
  return (
    <div className="space-y-3">
      {tab.permissions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No data access. The tab only sees its own settings, storage and the current theme.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Permissions">
          {tab.permissions.map((scope) => {
            const { title, description } = describeScope(scope);
            return (
              <li key={scope} className="flex items-start gap-2.5">
                <ShieldCheck
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="text-xs font-medium leading-tight">
                    {title}
                    <span className="ml-1.5 font-mono text-[10.5px] font-normal text-muted-foreground">
                      {scope}
                    </span>
                    {added?.permissions.has(scope) ? <NewMark /> : null}
                  </p>
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{description}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <NetworkAccess
        origins={origins}
        reasoning={tab.network.reasoning ?? null}
        added={added?.origins}
      />
      <CustomTabExecution tab={tab} added={added} />
    </div>
  );
}

function NetworkAccess({
  origins,
  reasoning,
  added,
}: {
  origins: string[];
  reasoning: string | null;
  added?: ReadonlySet<string>;
}): React.JSX.Element {
  if (origins.length === 0) {
    return (
      <p className="flex items-center gap-2.5 text-xs text-muted-foreground">
        <Globe className="size-3.5 shrink-0" aria-hidden />
        No network access.
      </p>
    );
  }
  return (
    <div className="flex items-start gap-2.5">
      <Globe className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-medium leading-tight">Network, through Cadencr</p>
        <ul className="flex flex-wrap gap-1" aria-label="Allowed sites">
          {origins.map((origin) => (
            <li
              key={origin}
              className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-foreground"
            >
              {origin}
              {added?.has(origin) ? <NewMark /> : null}
            </li>
          ))}
        </ul>
        {reasoning ? (
          <p className="text-xs leading-snug text-muted-foreground">
            <span className="text-foreground/80">Why: </span>
            {reasoning}
          </p>
        ) : null}
      </div>
    </div>
  );
}

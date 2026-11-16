import { AlertTriangle, CpuIcon, TerminalIcon } from "lucide-react";
import type { PluginTabSummary } from "@/api/generated";
import { backendBinaries } from "@/components/plugin-tabs/plugin-tab-access";
import {
  BLOCKING_BANNER_CLASS,
  WARNING_BANNER_CLASS,
} from "@/components/settings/SettingsWarningsBanner";
import { cn } from "@/lib/utils";
import { NewMark } from "./CustomTabUpdateChanges";
import type { AddedAccess } from "./update-changes";

type ExecutionTab = Pick<PluginTabSummary, "commands" | "backend">;

/**
 * What a tab may run beyond its page: the programs Cadencr runs for it, and
 * its native backend. Shown under the permissions on the card and in the
 * consent dialog, with what each one really means — nothing when the tab is
 * read-only. Reviewing an update, `added` marks what the installed version
 * did not run.
 */
export function CustomTabExecution({
  tab,
  added,
}: {
  tab: ExecutionTab;
  added?: AddedAccess;
}): React.JSX.Element | null {
  if (tab.commands.length === 0 && !tab.backend) return null;
  return (
    <div className="space-y-3">
      <CommandsAccess commands={tab.commands} added={added?.commands} />
      <BackendAccess tab={tab} isNew={added?.backend ?? false} />
    </div>
  );
}

function CommandsAccess({
  commands,
  added,
}: {
  commands: ExecutionTab["commands"];
  added?: ReadonlySet<string>;
}) {
  if (commands.length === 0) return null;
  return (
    <div className="flex items-start gap-2.5">
      <TerminalIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--acc-yellow)]" aria-hidden />
      <div className="min-w-0 space-y-1.5">
        <p className="text-xs font-medium leading-tight">Runs commands on your computer</p>
        <ul className="space-y-1" aria-label="Commands">
          {commands.map((command) => (
            <li key={command.program} className="text-xs leading-snug text-muted-foreground">
              <span className="mr-1.5 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-foreground">
                {command.program}
              </span>
              {added?.has(command.program) ? <NewMark className="ml-0 mr-1.5" /> : null}
              {command.reasoning}
            </li>
          ))}
        </ul>
        <p className={cn(WARNING_BANNER_CLASS, "text-xs leading-snug")}>
          Cadencr runs these programs for the tab, without a shell, in this conversation&apos;s
          folder, with whatever arguments the tab chooses. Most programs can run any code from their
          arguments (<span className="font-mono">git</span> aliases,{" "}
          <span className="font-mono">find -exec</span>, <span className="font-mono">ssh</span>{" "}
          options), so the tab can do anything you can.
        </p>
      </div>
    </div>
  );
}

function BackendAccess({ tab, isNew }: { tab: ExecutionTab; isNew: boolean }) {
  const { backend } = tab;
  if (!backend) return null;
  return (
    <div className="flex items-start gap-2.5">
      <CpuIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--acc-red)]" aria-hidden />
      <div className="min-w-0 space-y-1.5">
        <p className="text-xs font-medium leading-tight">
          Runs native code with your rights
          {isNew ? <NewMark /> : null}
        </p>
        <p className="text-xs leading-snug text-muted-foreground">
          <span className="mr-1.5 break-all rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-foreground">
            {backendBinaries(backend)}
          </span>
          {backend.reasoning}
        </p>
        <p
          role="note"
          className={cn(BLOCKING_BANNER_CLASS, "flex items-start gap-2 text-xs leading-snug")}
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--acc-red)]" aria-hidden />
          <span>
            This program runs on your computer as you: it can read and change any of your files,
            start other programs and use the network. Cadencr does not sandbox it. Only its access
            to Cadencr data is limited, to the permissions above.
          </span>
        </p>
      </div>
    </div>
  );
}

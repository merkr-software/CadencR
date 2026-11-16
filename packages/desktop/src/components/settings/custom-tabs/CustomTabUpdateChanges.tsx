import { CpuIcon, ListChecks } from "lucide-react";
import type {
  PluginTabBackendBinary,
  PluginTabPendingUpdate,
  PluginTabSummary,
} from "@/api/generated";
import { platformList } from "@/components/plugin-tabs/plugin-tab-access";
import { cn } from "@/lib/utils";
import {
  hasAdditions,
  nativeProgramChange,
  shortDigest,
  type AddedAccess,
  type NativeProgramChange,
} from "./update-changes";

/** Marks an item the staged update asks for and the installed version does not. */
export function NewMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        "ml-1.5 rounded-sm bg-[var(--acc-orange)]/14 px-1 py-px align-middle font-sans text-[9.5px] font-semibold uppercase tracking-wide text-[var(--acc-orange)]",
        className,
      )}
    >
      New
    </span>
  );
}

/**
 * What a staged update changes against the installed version, before the list
 * of what it asks for: the native program (short digests old → new, and its
 * protocol), and whether anything below is new. A binary-only update asks
 * for the very same permissions, so this is the only place it shows.
 */
export function CustomTabUpdateChanges({
  tab,
  update,
  added,
}: {
  tab: PluginTabSummary;
  update: PluginTabPendingUpdate;
  added: AddedAccess;
}): React.JSX.Element {
  const program = nativeProgramChange(tab, update);
  const since = tab.version ? ` since ${tab.version}` : "";
  return (
    <section
      aria-label="What changes"
      className="space-y-2 rounded-lg border border-border/80 bg-muted/40 px-3 py-2.5"
    >
      {program ? <ProgramChange change={program} /> : null}
      <p className="flex items-start gap-2.5 text-xs leading-snug">
        <ListChecks className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span>
          {hasAdditions(added)
            ? `It asks for more${since}: what is new is marked below.`
            : `It asks for nothing new${since}.`}
        </span>
      </p>
    </section>
  );
}

function ProgramChange({ change }: { change: NativeProgramChange }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5 text-xs leading-snug">
      <CpuIcon className="mt-0.5 size-3.5 shrink-0 text-[var(--acc-red)]" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">
          {change.kind === "added"
            ? "Adds a native program"
            : change.kind === "removed"
              ? "No longer runs a native program"
              : "The native program changes"}
        </p>
        {change.kind === "changed" ? <ChangedProgram from={change.from} to={change.to} /> : null}
        {change.kind === "added" && change.to ? (
          <p className="text-muted-foreground">
            <Digest value={change.to.executable_sha256} /> for {platformList([change.to.platform])},
            protocol {change.to.protocol}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ChangedProgram({
  from,
  to,
}: {
  from: PluginTabBackendBinary | null;
  to: PluginTabBackendBinary;
}): React.JSX.Element {
  return (
    <>
      <p className="text-muted-foreground" aria-label="Program digest">
        {from ? <Digest value={from.executable_sha256} /> : "the installed build"} →{" "}
        <Digest value={to.executable_sha256} /> ({platformList([to.platform])})
      </p>
      {from && from.protocol !== to.protocol ? (
        <p className="text-muted-foreground">
          Protocol {from.protocol} → {to.protocol}
        </p>
      ) : null}
    </>
  );
}

function Digest({ value }: { value: string }): React.JSX.Element {
  return (
    <span
      title={value}
      className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-foreground"
    >
      {shortDigest(value)}
    </span>
  );
}

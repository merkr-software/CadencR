import { memo } from "react";
import { LayoutDashboard, List, RefreshCw } from "lucide-react";
import type { CadencrError } from "@cadencr/tab-sdk";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TabsList,
  TabsTrigger,
  cn,
} from "@cadencr/tab-kit";
import { useTabContext } from "@cadencr/tab-sdk/react";

import { KindSwatch, LineCounts } from "./kind";
import { CORE_KINDS, KIND_ORDER, KINDS, formatCount, type Totals } from "./model";
import type { Scope } from "./useChangedFiles";

export type View = "treemap" | "list";

function Legend({ totals }: { totals: Totals }) {
  const kinds = KIND_ORDER.filter((kind) => CORE_KINDS.includes(kind) || totals.byKind[kind] > 0);
  return (
    <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {kinds.map((kind) => (
        <li
          key={kind}
          className={cn(
            "flex items-center gap-1.5 text-xs text-muted-foreground",
            totals.byKind[kind] === 0 && "opacity-60",
          )}
        >
          <KindSwatch kind={kind} />
          <span>{KINDS[kind].label}</span>
          <span className="font-mono text-[11px] tabular-nums">{totals.byKind[kind]}</span>
        </li>
      ))}
    </ul>
  );
}

function TotalsLine({ totals }: { totals: Totals }) {
  return (
    <p className="flex items-baseline gap-3 font-mono text-[11px] tabular-nums">
      <span className="text-foreground">
        {formatCount(totals.files)} {totals.files === 1 ? "file" : "files"}
      </span>
      <LineCounts additions={totals.additions} deletions={totals.deletions} />
    </p>
  );
}

/** The comparison picker: a filter on the data, so a select rather than tabs. */
function ScopeSelect(props: { value: Scope; onChange: (scope: Scope) => void }) {
  const { feature } = useTabContext();
  if (!feature.baseBranch) return null;
  return (
    <Select value={props.value} onValueChange={(value) => props.onChange(value as Scope)}>
      <SelectTrigger size="sm" aria-label="Compare" className="px-2 text-xs data-[size=sm]:h-7">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="uncommitted">Uncommitted</SelectItem>
        <SelectItem value="branch">vs {feature.baseBranch}</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** Rendered inside the app's view `<Tabs>`: the triggers switch its panels. */
function ViewTabs() {
  return (
    <TabsList aria-label="View" className="h-7 w-auto gap-0.5 rounded-md border-b-0 bg-muted p-0.5">
      <TabsTrigger
        value="treemap"
        title="Treemap"
        className="h-6 rounded-[5px] px-2 after:hidden data-[state=active]:bg-background data-[state=active]:shadow-xs"
      >
        <LayoutDashboard className="size-3.5" />
        <span className="sr-only">Treemap</span>
      </TabsTrigger>
      <TabsTrigger
        value="list"
        title="List"
        className="h-6 rounded-[5px] px-2 after:hidden data-[state=active]:bg-background data-[state=active]:shadow-xs"
      >
        <List className="size-3.5" />
        <span className="sr-only">List</span>
      </TabsTrigger>
    </TabsList>
  );
}

interface HeaderProps {
  totals: Totals | null;
  loading: boolean;
  scope: Scope;
  onScopeChange: (scope: Scope) => void;
  refreshing: boolean;
  refreshError: CadencrError | null;
  /** `useStorage` failed to load or save the chosen view. */
  viewError: CadencrError | null;
  onRefresh: () => void;
}

export const Header = memo(function Header(props: HeaderProps) {
  const { feature } = useTabContext();
  return (
    <header className="flex flex-col gap-2 border-b border-border/60 px-4 pt-3 pb-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="truncate text-sm leading-tight font-semibold">{feature.name}</h1>
          {props.totals ? (
            <TotalsLine totals={props.totals} />
          ) : props.loading ? (
            <p className="font-mono text-[11px] text-muted-foreground">Loading changes…</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <ScopeSelect value={props.scope} onChange={props.onScopeChange} />
          <ViewTabs />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh"
            title="Refresh"
            disabled={props.refreshing}
            onClick={props.onRefresh}
          >
            <RefreshCw className={cn(props.refreshing && "motion-safe:animate-spin")} />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {props.totals && props.totals.files > 0 ? <Legend totals={props.totals} /> : <span />}
        <div role="status" className="flex flex-col items-end text-xs text-destructive">
          {props.refreshError ? <p>Couldn't refresh: {props.refreshError.message}</p> : null}
          {props.viewError ? (
            <p>Couldn't load or save the view: {props.viewError.message}</p>
          ) : null}
        </div>
      </div>
    </header>
  );
});

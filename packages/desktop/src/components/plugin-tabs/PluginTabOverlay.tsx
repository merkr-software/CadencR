import type { ReactElement } from "react";
import {
  BanIcon,
  CircleOffIcon,
  CpuIcon,
  HammerIcon,
  MonitorIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from "lucide-react";

import type { TabIssue } from "@/api/generated";
import { EmptyState } from "@/components/FeaturePrViewParts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { TabIssueList } from "./TabIssueList";
import { BLOCKED_COPY, unavailableReason } from "./plugin-tab-access";

/** What the placeholder shows instead of (or until) the guest view. */
export type PluginTabOverlayState =
  | { kind: "loading" }
  | { kind: "remote" }
  | { kind: "disabled" }
  | { kind: "invalid"; errors: readonly TabIssue[] }
  /** On Cadencr's signed revocation list; `reason` is the list's own words. */
  | { kind: "blocked"; reason: string | null }
  /** Its backend ships no executable for this platform; `platforms` is where it runs. */
  | { kind: "unavailable"; platforms: string }
  | { kind: "not-built"; dir: string; canOpenProject: boolean }
  | { kind: "failed"; detail: string | null }
  | { kind: "crashed"; detail: string | null };

export interface PluginTabOverlayProps {
  state: PluginTabOverlayState;
  name: string;
  onReload: () => void;
  onManage: () => void;
  onOpenProject: () => void;
  openingProject?: boolean;
}

const ICON = "size-5";

export function PluginTabOverlay(props: PluginTabOverlayProps): ReactElement {
  const { state, name } = props;
  switch (state.kind) {
    case "loading":
      return <PluginTabSkeleton name={name} />;
    case "remote":
      return (
        <EmptyState
          icon={<MonitorIcon className={ICON} aria-hidden />}
          title="Desktop only"
          description={`${name} is a custom tab. Custom tabs are available in the Cadencr desktop app.`}
        />
      );
    case "disabled":
      return (
        <EmptyState
          icon={<CircleOffIcon className={ICON} aria-hidden />}
          title={`${name} is off`}
          description="This custom tab isn't turned on for this project. Turn it on in Settings to use it here."
          action={<ManageButton onManage={props.onManage} />}
        />
      );
    case "invalid":
      return (
        <EmptyState
          icon={<TriangleAlertIcon className={ICON} aria-hidden />}
          title={`${name} can't load`}
          description="Its tab.json has problems. Fix them and the tab reloads by itself."
          action={
            <div className="space-y-3">
              <TabIssueList
                issues={state.errors}
                className="max-h-40 overflow-y-auto rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2"
              />
              <ManageButton onManage={props.onManage} />
            </div>
          }
        />
      );
    case "blocked":
      return (
        <EmptyState
          icon={<BanIcon className={ICON} aria-hidden />}
          title={`${name} is blocked`}
          description={`${BLOCKED_COPY.effect} ${BLOCKED_COPY.remedy}`}
          detail={state.reason}
          action={<ManageButton onManage={props.onManage} />}
        />
      );
    case "unavailable":
      return (
        <EmptyState
          icon={<CpuIcon className={ICON} aria-hidden />}
          title={`${name} isn't available on this platform`}
          description={unavailableReason(state.platforms)}
          action={<ManageButton onManage={props.onManage} />}
        />
      );
    case "not-built":
      return <NotBuiltState {...props} dir={state.dir} canOpenProject={state.canOpenProject} />;
    case "failed":
      return (
        <EmptyState
          icon={<TriangleAlertIcon className={ICON} aria-hidden />}
          title={`${name} failed to load`}
          description="Cadencr couldn't load the tab's page."
          detail={state.detail}
          action={<ReloadButton onReload={props.onReload} />}
        />
      );
    case "crashed":
      return (
        <EmptyState
          icon={<TriangleAlertIcon className={ICON} aria-hidden />}
          title={`${name} stopped`}
          description="The tab's page crashed. Reload to start it again."
          detail={state.detail}
          action={<ReloadButton onReload={props.onReload} />}
        />
      );
  }
}

function NotBuiltState({
  name,
  dir,
  canOpenProject,
  onReload,
  onOpenProject,
  openingProject,
}: PluginTabOverlayProps & { dir: string; canOpenProject: boolean }): ReactElement {
  return (
    <EmptyState
      icon={<HammerIcon className={ICON} aria-hidden />}
      title={`${name} isn't built yet`}
      description="Cadencr shows the tab from its dist/ folder. Build it once and it appears here."
      action={
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-[var(--surface-sunken)] px-3 py-2 text-left">
            <code className="block font-mono text-[12px] text-foreground">npm run build</code>
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={dir}>
              in {dir}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {canOpenProject && (
              <Button size="sm" variant="outline" onClick={onOpenProject} disabled={openingProject}>
                Open project
              </Button>
            )}
            <ReloadButton onReload={onReload} />
          </div>
        </div>
      }
    />
  );
}

function ReloadButton({ onReload }: { onReload: () => void }): ReactElement {
  return (
    <Button size="sm" variant="outline" onClick={onReload}>
      <RotateCwIcon className="size-4" aria-hidden />
      Reload
    </Button>
  );
}

function ManageButton({ onManage }: { onManage: () => void }): ReactElement {
  return (
    <Button size="sm" variant="outline" onClick={onManage}>
      Manage custom tabs
    </Button>
  );
}

/** Generic page silhouette while the guest boots (the view stays hidden meanwhile). */
function PluginTabSkeleton({ name }: { name: string }): ReactElement {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={`Loading ${name}`}
      className="flex h-full min-h-0 flex-col gap-4 p-4"
    >
      <div className="flex items-center gap-3">
        <Skeleton className="h-5 w-40" />
        <div className="flex-1" />
        <Skeleton className="h-7 w-20" />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-3">
        <Skeleton className="col-span-2 h-full rounded-lg" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}

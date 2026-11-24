import { type UiTranslator, useUiTranslation } from "@/lib/i18n/ui";
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
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-errors";
import { Skeleton } from "@/components/ui/skeleton";

import type { GuestPhase } from "./usePluginTabGuest";
import { TabIssueList } from "./TabIssueList";
import { blockedCopy, platformList, unavailableReason } from "./plugin-tab-access";

/** What the placeholder shows instead of (or until) the guest view. */
export type PluginTabOverlayState =
  | { kind: "loading" }
  | { kind: "remote" }
  | { kind: "disabled" }
  | { kind: "invalid"; errors: readonly TabIssue[] }
  /** On Cadencr's signed revocation list; `reason` is the list's own words. */
  | { kind: "blocked"; reason: string | null }
  /** Its backend ships no executable for this platform; `platforms` is where it runs. */
  | { kind: "unavailable"; platforms: readonly string[] }
  | { kind: "not-built"; dir: string; canOpenProject: boolean }
  | Extract<GuestPhase, { kind: "failed" }>
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
  const { t } = useUiTranslation();
  const { state, name } = props;
  switch (state.kind) {
    case "loading":
      return <PluginTabSkeleton name={name} />;
    case "remote":
      return (
        <EmptyState
          icon={<MonitorIcon className={ICON} aria-hidden />}
          title={t("customTabs.pluginTabOverlay.desktopOnly", "Desktop only")}
          description={t(
            "customTabs.pluginTabOverlay.desktopDescription",
            "{{name}} is a custom tab. Custom tabs are available in the Cadencr desktop app.",
            { name },
          )}
        />
      );
    case "disabled":
      return (
        <EmptyState
          icon={<CircleOffIcon className={ICON} aria-hidden />}
          title={t("customTabs.pluginTabOverlay.disabledTitle", "{{name}} is off", { name })}
          description={t(
            "customTabs.pluginTabOverlay.thisCustomTabIsnTTurnedOnFor",
            "This custom tab isn't turned on for this project. Turn it on in Settings to use it here.",
          )}
          action={<ManageButton onManage={props.onManage} />}
        />
      );
    case "invalid":
      return (
        <EmptyState
          icon={<TriangleAlertIcon className={ICON} aria-hidden />}
          title={t("customTabs.pluginTabOverlay.invalidTitle", "{{name}} can't load", { name })}
          description={t(
            "customTabs.pluginTabOverlay.itsTabJsonHasProblemsFixThemAnd",
            "Its tab.json has problems. Fix them and the tab reloads by itself.",
          )}
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
    case "blocked": {
      const blocked = blockedCopy(t);
      return (
        <EmptyState
          icon={<BanIcon className={ICON} aria-hidden />}
          title={t("customTabs.pluginTabOverlay.blockedTitle", "{{name}} is blocked", { name })}
          description={`${blocked.effect} ${blocked.remedy}`}
          detail={state.reason}
          action={<ManageButton onManage={props.onManage} />}
        />
      );
    }
    case "unavailable":
      return (
        <EmptyState
          icon={<CpuIcon className={ICON} aria-hidden />}
          title={t(
            "customTabs.pluginTabOverlay.unavailableTitle",
            "{{name}} isn't available on this platform",
            { name },
          )}
          description={unavailableReason(platformList(state.platforms, t), t)}
          action={<ManageButton onManage={props.onManage} />}
        />
      );
    case "not-built":
      return <NotBuiltState {...props} dir={state.dir} canOpenProject={state.canOpenProject} />;
    case "failed":
    case "crashed":
      return <GuestFailureOverlay state={state} name={name} onReload={props.onReload} />;
  }
}

function GuestFailureOverlay({
  state,
  name,
  onReload,
}: Pick<PluginTabOverlayProps, "name" | "onReload"> & {
  state: Extract<PluginTabOverlayState, { kind: "failed" | "crashed" }>;
}): ReactElement {
  const { t } = useUiTranslation();
  switch (state.kind) {
    case "failed":
      return (
        <EmptyState
          icon={<TriangleAlertIcon className={ICON} aria-hidden />}
          title={t("customTabs.pluginTabOverlay.failedTitle", "{{name}} failed to load", { name })}
          description={t(
            "customTabs.pluginTabOverlay.cadencrCouldnTLoadTheTabSPage",
            "Cadencr couldn't load the tab's page.",
          )}
          detail={guestFailureDetail(state.detail, t)}
          action={<ReloadButton onReload={onReload} />}
        />
      );
    case "crashed":
      return (
        <EmptyState
          icon={<TriangleAlertIcon className={ICON} aria-hidden />}
          title={t("customTabs.pluginTabOverlay.crashedTitle", "{{name}} stopped", { name })}
          description={t(
            "customTabs.pluginTabOverlay.theTabSPageCrashedReloadToStart",
            "The tab's page crashed. Reload to start it again.",
          )}
          detail={state.detail}
          action={<ReloadButton onReload={onReload} />}
        />
      );
  }
}

function guestFailureDetail(
  detail: Extract<GuestPhase, { kind: "failed" }>["detail"],
  t: UiTranslator,
): string | null {
  if (detail === null || typeof detail === "string") return detail;
  if ("kind" in detail) {
    return t("customTabs.native.unknownInstance", "Unknown custom tab instance: {{id}}", {
      id: detail.instanceId,
    });
  }
  return apiErrorMessage(detail.cause, guestFailureLabel(detail.operation, t));
}

function guestFailureLabel(operation: "open" | "reload" | "reopen", t: UiTranslator): string {
  switch (operation) {
    case "open":
      return t("customTabs.guest.openError", "The tab could not be opened");
    case "reload":
      return t("customTabs.guest.reloadError", "Reload failed");
    case "reopen":
      return t("customTabs.guest.reopenError", "The tab could not be reopened");
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
  const { t } = useUiTranslation();
  return (
    <EmptyState
      icon={<HammerIcon className={ICON} aria-hidden />}
      title={t("customTabs.pluginTabOverlay.notBuiltTitle", "{{name}} isn't built yet", { name })}
      description={t(
        "customTabs.pluginTabOverlay.cadencrShowsTheTabFromItsDist",
        "Cadencr shows the tab from its dist/ folder. Build it once and it appears here.",
      )}
      action={
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-[var(--surface-sunken)] px-3 py-2 text-left">
            <code className="block font-mono text-[12px] text-foreground">npm run build</code>
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={dir}>
              {t("customTabs.pluginTabOverlay.buildDirectory", "in {{dir}}", { dir })}
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {canOpenProject && (
              <Button size="sm" variant="outline" onClick={onOpenProject} disabled={openingProject}>
                {t("customTabs.pluginTabOverlay.openProject", "Open project")}
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
  const { t } = useUiTranslation();
  return (
    <Button size="sm" variant="outline" onClick={onReload}>
      <RotateCwIcon className="size-4" aria-hidden />
      {t("customTabs.pluginTabOverlay.reload", "Reload")}
    </Button>
  );
}

function ManageButton({ onManage }: { onManage: () => void }): ReactElement {
  const { t } = useUiTranslation();
  return (
    <Button size="sm" variant="outline" onClick={onManage}>
      {t("customTabs.pluginTabOverlay.manageCustomTabs", "Manage custom tabs")}
    </Button>
  );
}

/** Generic page silhouette while the guest boots (the view stays hidden meanwhile). */
function PluginTabSkeleton({ name }: { name: string }): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("customTabs.pluginTabOverlay.loadingLabel", "Loading {{name}}", { name })}
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

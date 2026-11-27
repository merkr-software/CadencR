import { translateUi, UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { useState, type ReactNode } from "react";
import { Code2, Copy, FolderOpen, Loader2, RotateCcw } from "lucide-react";
import type { TabIssue } from "@/api/generated";
import { TabIssueList } from "@/components/plugin-tabs/TabIssueList";
import {
  backendPlatforms,
  blockedCopy,
  reasonSentence,
  unavailableHere,
  unavailableReason,
} from "@/components/plugin-tabs/plugin-tab-access";
import { SettingsBanner, WARNING_BANNER_CLASS } from "@/components/settings/SettingsWarningsBanner";
import { Button } from "@/components/ui/button";
import { toastError } from "@/lib/api-errors";
import { copyToClipboard } from "@/lib/clipboard";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import { declaredReplacements } from "@/lib/plugin-tabs/tab-replacements";
import { cn } from "@/lib/utils";
import { CustomTabAvailability } from "./CustomTabAvailability";
import { customTabStatus } from "./custom-tab-model";
import type { CustomTabCardProps } from "./CustomTabCard";
import { CustomTabConfiguration } from "./CustomTabConfiguration";
import { CustomTabPermissions } from "./CustomTabPermissions";
import { CustomTabReplaces } from "./CustomTabReplaces";
import { CustomTabShortcuts } from "./CustomTabShortcuts";
import { CustomTabUpdateNotice } from "./CustomTabUpdateNotice";

/** The expanded half of a custom tab card. */
export function CustomTabDetails({
  tab,
  projects,
  overrides,
  enablement,
  opener,
  paused,
}: CustomTabCardProps & { paused: boolean }): React.JSX.Element {
  const { t } = useUiTranslation();
  const hasIssues = tab.errors.length > 0 || tab.warnings.length > 0;
  const notBuilt = tab.status === "valid" && !tab.entry_present;
  const unavailable = customTabStatus(tab) === "unavailable" ? tab.backend : null;
  const blocked = tab.status === "blocked";
  return (
    <>
      {hasIssues || notBuilt || paused || unavailable || blocked || tab.pending_update ? (
        <div className="space-y-2 px-4 pt-4">
          {blocked ? <BlockedNote reason={tab.blocked_reason ?? null} /> : null}
          <IssueBanner
            tone="blocking"
            title={t("customTabs.customTabDetails.notLoaded", "Not loaded")}
            issues={tab.errors}
          />
          <IssueBanner
            tone="warning"
            title={t("customTabs.customTabDetails.warnings", "Warnings")}
            issues={tab.warnings}
          />
          {unavailable ? <UnavailableNote platforms={backendPlatforms(unavailable, t)} /> : null}
          {notBuilt ? <NotBuiltNote dir={tab.dir} entry={tab.entry ?? "dist/index.html"} /> : null}
          {paused ? <PausedNote onReview={() => enablement.review(tab)} /> : null}
          <CustomTabUpdateNotice tab={tab} onReview={() => enablement.reviewUpdate(tab)} />
        </div>
      ) : null}
      <DetailBlock
        title={t("customTabs.customTabDetails.permissions", "Permissions")}
        divided={false}
      >
        <CustomTabPermissions tab={tab} />
      </DetailBlock>
      <DetailBlock title={t("customTabs.customTabDetails.availability", "Availability")}>
        <CustomTabAvailability
          tab={tab}
          projects={projects}
          overrides={overrides}
          enablement={enablement}
        />
      </DetailBlock>
      {declaredReplacements(tab.replaces).length > 0 ? (
        <DetailBlock title={t("customTabs.customTabDetails.replaces", "Replaces")}>
          <CustomTabReplaces tab={tab} />
        </DetailBlock>
      ) : null}
      {tab.shortcuts.length > 0 ? (
        <DetailBlock
          title={t("customTabs.customTabDetails.keyboardShortcuts", "Keyboard shortcuts")}
        >
          <CustomTabShortcuts tab={tab} />
        </DetailBlock>
      ) : null}
      {tab.configuration.length > 0 ? (
        <DetailBlock title={t("customTabs.customTabDetails.settings", "Settings")}>
          {tab.status === "valid" ? (
            <CustomTabConfiguration tab={tab} projects={projects} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {blocked
                ? t(
                    "customTabs.customTabDetails.blockedSettings",
                    "A blocked tab's settings can't be changed.",
                  )
                : t(
                    "customTabs.customTabDetails.invalidSettings",
                    "Fix the issues above to edit its settings.",
                  )}
            </p>
          )}
        </DetailBlock>
      ) : null}
      <CardActions tab={tab} opener={opener} />
    </>
  );
}

function DetailBlock({
  title,
  divided = true,
  children,
}: {
  title: string;
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={cn("space-y-3 px-4 py-4", divided && "border-t border-border/50")}>
      <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  );
}

/** Validation findings under a banner of their severity. */
function IssueBanner({
  tone,
  title,
  issues,
}: {
  tone: "blocking" | "warning";
  title: string;
  issues: TabIssue[];
}): React.JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <SettingsBanner tone={tone} title={title} role={tone === "blocking" ? "alert" : "status"}>
      <TabIssueList issues={issues} className="mt-1.5" />
    </SettingsBanner>
  );
}

/** Revoked through Cadencr's signed blocklist: only removal (or a version not blocked) helps. */
function BlockedNote({ reason }: { reason: string | null }): React.JSX.Element {
  const { t } = useUiTranslation();
  const blocked = blockedCopy(t);
  return (
    <SettingsBanner tone="blocking" title={blocked.title} role="alert">
      <p className="mt-1.5 text-muted-foreground">
        {reason ? <span className="text-foreground">{reasonSentence(reason)} </span> : null}
        {blocked.effect} {blocked.remedy}
      </p>
    </SettingsBanner>
  );
}

function UnavailableNote({ platforms }: { platforms: string }): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <p className={cn(WARNING_BANNER_CLASS, "text-xs text-muted-foreground")}>
      <span className="font-medium text-foreground">{unavailableHere(t)}.</span>{" "}
      {unavailableReason(platforms, t)}{" "}
      <UiTrans
        i18nKey="customTabs.customTabDetails.unavailableNote"
        defaults="It runs here once its tab.json lists a <property/> for this platform."
        components={{ property: <span className="font-mono">backend.binary</span> }}
      />
    </p>
  );
}

function NotBuiltNote({ dir, entry }: { dir: string; entry: string }): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <p className={cn(WARNING_BANNER_CLASS, "text-xs text-muted-foreground")}>
      <span className="font-medium text-foreground">
        {t("customTabs.customTabDetails.notBuiltYet", "Not built yet.")}
      </span>{" "}
      <UiTrans
        i18nKey="customTabs.customTabDetails.buildInstructions"
        defaults="Cadencr loads <entry/>: run <command/> in <directory/>, or ask the agent in its project."
        components={{
          entry: <span className="font-mono">{entry}</span>,
          command: <span className="font-mono">npm run build</span>,
          directory: <span className="break-all font-mono">{dir}</span>,
        }}
      />
    </p>
  );
}

function PausedNote({ onReview }: { onReview: () => void }): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div className={cn(WARNING_BANNER_CLASS, "flex items-center gap-3 text-xs")}>
      <p className="min-w-0 flex-1 text-muted-foreground">
        <span className="font-medium text-foreground">
          {t("customTabs.customTabDetails.paused", "Paused.")}
        </span>{" "}
        {t(
          "customTabs.customTabDetails.pausedDescription",
          "Its permissions changed since you allowed them. It stays off until you review them.",
        )}
      </p>
      <Button type="button" size="xs" variant="outline" onClick={onReview}>
        {t("customTabs.customTabDetails.reviewPermissions", "Review permissions")}
      </Button>
    </div>
  );
}

function CardActions({
  tab,
  opener,
}: Pick<CustomTabCardProps, "tab" | "opener">): React.JSX.Element {
  const { t } = useUiTranslation();
  const opening = opener.openingId === tab.id;
  const hasProject = tab.authoring_project_id != null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-4 py-3">
      <Button
        variant="outline"
        size="xs"
        className="gap-1.5"
        disabled={opening || tab.managed === true}
        onClick={() => opener.open(tab.id, hasProject ? "open" : "setup")}
      >
        {opening ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : hasProject ? (
          <Code2 className="size-3.5" aria-hidden />
        ) : (
          <RotateCcw className="size-3.5" aria-hidden />
        )}
        {tab.managed
          ? t("customTabs.customTabDetails.marketplaceInstallation", "Marketplace installation")
          : hasProject
            ? t("customTabs.customTabDetails.openProject", "Open project")
            : t("customTabs.customTabDetails.retrySetup", "Retry setup")}
      </Button>
      {isDesktopShell() ? <RevealButton dir={tab.dir} /> : null}
      <Button
        variant="ghost"
        size="xs"
        className="gap-1.5"
        onClick={() =>
          void copyToClipboard(
            tab.dir,
            translateUi("customTabs.customTabDetails.folderCopied", "Custom tab folder copied"),
          )
        }
      >
        <Copy className="size-3.5" aria-hidden />
        {t("customTabs.customTabDetails.copyPath", "Copy path")}
      </Button>
    </div>
  );
}

function RevealButton({ dir }: { dir: string }): React.JSX.Element {
  const { t } = useUiTranslation();
  const [pending, setPending] = useState(false);
  const reveal = async (): Promise<void> => {
    setPending(true);
    try {
      await desktopBridge.revealInFinder(dir);
    } catch (error: unknown) {
      toastError(
        error,
        translateUi(
          "customTabs.customTabDetails.revealError",
          "Could not reveal the custom tab's folder",
        ),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Button
      variant="ghost"
      size="xs"
      className="gap-1.5"
      disabled={pending}
      onClick={() => void reveal()}
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <FolderOpen className="size-3.5" aria-hidden />
      )}
      {t("customTabs.customTabDetails.revealFolder", "Reveal folder")}
    </Button>
  );
}

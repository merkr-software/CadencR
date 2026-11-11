import { useState, type ReactNode } from "react";
import { Code2, Copy, FolderOpen, Loader2, RotateCcw } from "lucide-react";
import type { TabIssue } from "@/api/generated";
import { TabIssueList } from "@/components/plugin-tabs/TabIssueList";
import {
  backendPlatforms,
  BLOCKED_COPY,
  reasonSentence,
  UNAVAILABLE_HERE,
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
  const hasIssues = tab.errors.length > 0 || tab.warnings.length > 0;
  const notBuilt = tab.status === "valid" && !tab.entry_present;
  const unavailable = customTabStatus(tab) === "unavailable" ? tab.backend : null;
  const blocked = tab.status === "blocked";
  return (
    <>
      {hasIssues || notBuilt || paused || unavailable || blocked || tab.pending_update ? (
        <div className="space-y-2 px-4 pt-4">
          {blocked ? <BlockedNote reason={tab.blocked_reason ?? null} /> : null}
          <IssueBanner tone="blocking" title="Not loaded" issues={tab.errors} />
          <IssueBanner tone="warning" title="Warnings" issues={tab.warnings} />
          {unavailable ? <UnavailableNote platforms={backendPlatforms(unavailable)} /> : null}
          {notBuilt ? <NotBuiltNote dir={tab.dir} entry={tab.entry ?? "dist/index.html"} /> : null}
          {paused ? <PausedNote onReview={() => enablement.review(tab)} /> : null}
          <CustomTabUpdateNotice tab={tab} onReview={() => enablement.reviewUpdate(tab)} />
        </div>
      ) : null}
      <DetailBlock title="Permissions" divided={false}>
        <CustomTabPermissions tab={tab} />
      </DetailBlock>
      <DetailBlock title="Availability">
        <CustomTabAvailability
          tab={tab}
          projects={projects}
          overrides={overrides}
          enablement={enablement}
        />
      </DetailBlock>
      {declaredReplacements(tab.replaces).length > 0 ? (
        <DetailBlock title="Replaces">
          <CustomTabReplaces tab={tab} />
        </DetailBlock>
      ) : null}
      {tab.shortcuts.length > 0 ? (
        <DetailBlock title="Keyboard shortcuts">
          <CustomTabShortcuts tab={tab} />
        </DetailBlock>
      ) : null}
      {tab.configuration.length > 0 ? (
        <DetailBlock title="Settings">
          {tab.status === "valid" ? (
            <CustomTabConfiguration tab={tab} projects={projects} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {blocked
                ? "A blocked tab's settings can't be changed."
                : "Fix the issues above to edit its settings."}
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
  return (
    <SettingsBanner tone="blocking" title={BLOCKED_COPY.title} role="alert">
      <p className="mt-1.5 text-muted-foreground">
        {reason ? <span className="text-foreground">{reasonSentence(reason)} </span> : null}
        {BLOCKED_COPY.effect} {BLOCKED_COPY.remedy}
      </p>
    </SettingsBanner>
  );
}

function UnavailableNote({ platforms }: { platforms: string }): React.JSX.Element {
  return (
    <p className={cn(WARNING_BANNER_CLASS, "text-xs text-muted-foreground")}>
      <span className="font-medium text-foreground">{UNAVAILABLE_HERE}.</span>{" "}
      {unavailableReason(platforms)} It runs here once its tab.json lists a{" "}
      <span className="font-mono">backend.binary</span> for this platform.
    </p>
  );
}

function NotBuiltNote({ dir, entry }: { dir: string; entry: string }): React.JSX.Element {
  return (
    <p className={cn(WARNING_BANNER_CLASS, "text-xs text-muted-foreground")}>
      <span className="font-medium text-foreground">Not built yet.</span> Cadencr loads{" "}
      <span className="font-mono">{entry}</span>: run{" "}
      <span className="font-mono">npm run build</span> in{" "}
      <span className="break-all font-mono">{dir}</span>, or ask the agent in its project.
    </p>
  );
}

function PausedNote({ onReview }: { onReview: () => void }): React.JSX.Element {
  return (
    <div className={cn(WARNING_BANNER_CLASS, "flex items-center gap-3 text-xs")}>
      <p className="min-w-0 flex-1 text-muted-foreground">
        <span className="font-medium text-foreground">Paused.</span> Its permissions changed since
        you allowed them. It stays off until you review them.
      </p>
      <Button type="button" size="xs" variant="outline" onClick={onReview}>
        Review permissions
      </Button>
    </div>
  );
}

function CardActions({
  tab,
  opener,
}: Pick<CustomTabCardProps, "tab" | "opener">): React.JSX.Element {
  const opening = opener.openingId === tab.id;
  const hasProject = tab.authoring_project_id != null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border/50 px-4 py-3">
      <Button
        variant="outline"
        size="xs"
        className="gap-1.5"
        disabled={opening || tab.managed === true}
        onClick={() =>
          opener.open(
            tab.id,
            hasProject
              ? "Could not open the custom tab's project"
              : "Could not set up the custom tab's project",
          )
        }
      >
        {opening ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : hasProject ? (
          <Code2 className="size-3.5" aria-hidden />
        ) : (
          <RotateCcw className="size-3.5" aria-hidden />
        )}
        {tab.managed ? "Marketplace installation" : hasProject ? "Open project" : "Retry setup"}
      </Button>
      {isDesktopShell() ? <RevealButton dir={tab.dir} /> : null}
      <Button
        variant="ghost"
        size="xs"
        className="gap-1.5"
        onClick={() => void copyToClipboard(tab.dir, "Custom tab folder copied")}
      >
        <Copy className="size-3.5" aria-hidden />
        Copy path
      </Button>
    </div>
  );
}

function RevealButton({ dir }: { dir: string }): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const reveal = async (): Promise<void> => {
    setPending(true);
    try {
      await desktopBridge.revealInFinder(dir);
    } catch (error: unknown) {
      toastError(error, "Could not reveal the custom tab's folder");
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
      Reveal folder
    </Button>
  );
}

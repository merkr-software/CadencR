import { SiteIdentity } from "./BrowserSiteIdentity";
import { type UiTranslator, useUiTranslation } from "@/lib/i18n/ui";
import { useEffect, useState, type ReactElement } from "react";
import {
  CameraIcon,
  ClipboardIcon,
  GlobeIcon,
  Loader2Icon,
  LockIcon,
  MapPinIcon,
  MicIcon,
  Trash2Icon,
} from "lucide-react";
import { AgentIcon } from "@/components/AgentIcon";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type {
  BrowserSitePermission,
  BrowserSitePermissionDecision,
  BrowserTabMetadata,
} from "@/lib/desktop-bridge";
import {
  BROWSER_SITE_PERMISSIONS,
  BROWSER_SITE_PERMISSION_DECISIONS,
} from "@/shared/browser-types";
import { isSecureUrl } from "./format-context";
import {
  useBrowserSiteInfo,
  type BrowserSiteInfoController,
  type BrowserSiteTarget,
} from "./useBrowserSiteInfo";

const PERMISSION_DETAILS: Record<
  BrowserSitePermission,
  {
    label: (t: UiTranslator) => string;
    Icon: typeof CameraIcon;
  }
> = {
  camera: {
    label: (t: UiTranslator) => t("workspace.tools.browserSiteInformation.camera", "Camera"),
    Icon: CameraIcon,
  },
  microphone: {
    label: (t: UiTranslator) =>
      t("workspace.tools.browserSiteInformation.microphone", "Microphone"),
    Icon: MicIcon,
  },
  location: {
    label: (t: UiTranslator) => t("workspace.tools.browserSiteInformation.location", "Location"),
    Icon: MapPinIcon,
  },
  clipboard: {
    label: (t: UiTranslator) => t("workspace.tools.browserSiteInformation.clipboard", "Clipboard"),
    Icon: ClipboardIcon,
  },
};

interface Confirmation {
  kind: "share" | "clear";
  target: BrowserSiteTarget;
}

interface BrowserSiteInformationProps {
  activeTab: BrowserTabMetadata | null;
  onOverlayOpenChange: (open: boolean) => void;
}

export function BrowserSiteInformation({
  activeTab,
  onOverlayOpenChange,
}: BrowserSiteInformationProps): ReactElement {
  const { t } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const controller = useBrowserSiteInfo(activeTab, open);

  useEffect(() => {
    onOverlayOpenChange(open || confirmation !== null);
    return () => onOverlayOpenChange(false);
  }, [confirmation, onOverlayOpenChange, open]);

  useEffect(() => {
    setConfirmation(null);
  }, [activeTab?.id, activeTab?.url]);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
  }

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            disabled={!activeTab}
            aria-label={t(
              "workspace.tools.browserSiteInformation.siteInformationAndPermissions",
              "Site information and permissions",
            )}
          >
            {isSecureUrl(activeTab?.url) ? (
              <LockIcon className="size-3.5 text-[var(--acc-green)]" />
            ) : (
              <GlobeIcon className="size-3.5" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-3 p-3">
          <SitePanel controller={controller} onConfirm={setConfirmation} />
        </PopoverContent>
      </Popover>
      <SiteConfirmation
        confirmation={confirmation}
        busy={controller.action === "sharing" || controller.action === "clearing"}
        onCancel={() => setConfirmation(null)}
        onConfirm={async () => {
          if (confirmation?.kind === "share") {
            await controller.setSharing(confirmation.target, true);
          }
          if (confirmation?.kind === "clear") await controller.clearData(confirmation.target);
        }}
      />
    </>
  );
}

function SitePanel({
  controller,
  onConfirm,
}: {
  controller: BrowserSiteInfoController;
  onConfirm: (confirmation: Confirmation | null) => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const { info } = controller;
  if (controller.loading && !info) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />{" "}
        {t(
          "workspace.tools.browserSiteInformation.loadingSiteInformation",
          "Loading site information…",
        )}
      </div>
    );
  }
  if (!info)
    return (
      <p className="py-4 text-sm text-muted-foreground">
        {t("workspace.tools.browserSiteInformation.noSiteIsLoaded", "No site is loaded.")}
      </p>
    );
  return (
    <>
      <SiteIdentity info={info} />
      <Separator />
      <section aria-labelledby="website-permissions-heading" className="space-y-2">
        <h3
          id="website-permissions-heading"
          className="text-xs font-medium uppercase tracking-wide"
        >
          {t("workspace.tools.browserSiteInformation.websitePermissions", "Website permissions")}
        </h3>
        {BROWSER_SITE_PERMISSIONS.map((permission) => {
          const { label, Icon } = PERMISSION_DETAILS[permission];
          return (
            <PermissionRow
              key={permission}
              label={label(t)}
              Icon={Icon}
              disabled={!info.origin || controller.action !== null}
              value={info.permissions[permission]}
              onChange={(decision) => void controller.setPermission(permission, decision)}
            />
          );
        })}
      </section>
      <Separator />
      <AgentSharing controller={controller} onConfirm={onConfirm} />
      <Separator />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full justify-start text-destructive hover:text-destructive"
        disabled={!info.origin || controller.action !== null}
        onClick={() => {
          if (info.origin)
            onConfirm({ kind: "clear", target: { tabId: info.tabId, origin: info.origin } });
        }}
      >
        <Trash2Icon className="size-3.5" />{" "}
        {t(
          "workspace.tools.browserSiteInformation.clearDataForThisSite",
          "Clear data for this site…",
        )}
      </Button>
    </>
  );
}

function PermissionRow({
  label,
  Icon,
  value,
  disabled,
  onChange,
}: {
  label: string;
  Icon: typeof CameraIcon;
  value: BrowserSitePermissionDecision;
  disabled: boolean;
  onChange: (decision: BrowserSitePermissionDecision) => void;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span>{label}</span>
      </div>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (isPermissionDecision(next)) onChange(next);
        }}
      >
        <SelectTrigger
          size="sm"
          className="w-24"
          aria-label={t(
            "workspace.tools.browserSiteInformation.permissionLabel",
            "{{label}} permission",
            { label },
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ask">
            {t("workspace.tools.browserSiteInformation.ask", "Ask")}
          </SelectItem>
          <SelectItem value="allow">
            {t("workspace.tools.browserSiteInformation.allow", "Allow")}
          </SelectItem>
          <SelectItem value="deny">
            {t("workspace.tools.browserSiteInformation.block", "Block")}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function AgentSharing({
  controller,
  onConfirm,
}: {
  controller: BrowserSiteInfoController;
  onConfirm: (confirmation: Confirmation | null) => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const info = controller.info;
  if (!info) return <></>;
  const shared = info.agentAccess !== "user";
  return (
    <section aria-labelledby="agent-sharing-heading" className="space-y-2">
      <div className="flex items-start gap-2">
        <AgentIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 id="agent-sharing-heading" className="text-sm font-medium">
            {t("workspace.tools.browserSiteInformation.agentSharing", "Agent sharing")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "workspace.tools.browserSiteInformation.separateFromWebsitePermissionsSharingLetsThe",
              "Separate from website permissions. Sharing lets the agent read and control this tab.",
            )}
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant={shared ? "outline" : "secondary"}
        size="sm"
        className="w-full"
        disabled={!info.origin || controller.action !== null}
        onClick={() => {
          if (shared && info.origin) {
            void controller.setSharing({ tabId: info.tabId, origin: info.origin }, false);
          } else if (info.origin) {
            onConfirm({ kind: "share", target: { tabId: info.tabId, origin: info.origin } });
          }
        }}
      >
        {shared
          ? t("workspace.tools.browserSiteInformation.revokeAgentAccess", "Revoke agent access")
          : t(
              "workspace.tools.browserSiteInformation.shareThisTabWithAgent",
              "Share this tab with agent…",
            )}
      </Button>
    </section>
  );
}

function SiteConfirmation({
  confirmation,
  busy,
  onCancel,
  onConfirm,
}: {
  confirmation: Confirmation | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}): ReactElement {
  const { t } = useUiTranslation();
  const sharing = confirmation?.kind === "share";
  return (
    <ConfirmDialog
      open={confirmation !== null}
      onOpenChange={(next) => !next && onCancel()}
      title={
        sharing
          ? t(
              "workspace.tools.browserSiteInformation.shareThisTabWithTheAgent",
              "Share this tab with the agent?",
            )
          : t("workspace.tools.browserSiteInformation.clearSiteDataTitle", "Clear site data?")
      }
      description={
        sharing
          ? t(
              "workspace.tools.browserSiteInformation.theAgentWillBeAbleToRead",
              "The agent will be able to read and control everything visible in this tab, including signed-in account data. Access lasts until you revoke it or close the tab.",
            )
          : t(
              "workspace.tools.browserSiteInformation.storageAndCacheForThisOriginWill",
              "Storage and cache for this origin will be removed from this tab’s actual browser profile. Chromium may also remove cookies shared by the same registrable domain; other profiles are not cleared.",
            )
      }
      confirmText={
        sharing
          ? t("workspace.tools.browserSiteInformation.shareWithAgent", "Share with agent")
          : t("workspace.tools.browserSiteInformation.clearSiteData", "Clear site data")
      }
      variant={sharing ? "default" : "destructive"}
      busy={busy}
      onConfirm={onConfirm}
    />
  );
}

function isPermissionDecision(value: string): value is BrowserSitePermissionDecision {
  return BROWSER_SITE_PERMISSION_DECISIONS.some((decision) => decision === value);
}

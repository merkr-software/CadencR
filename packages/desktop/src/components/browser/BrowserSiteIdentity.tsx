import type { ReactElement } from "react";
import { EyeOffIcon, GlobeIcon, ShieldCheckIcon } from "lucide-react";
import { useUiTranslation } from "@/lib/i18n/ui";
import type { BrowserSiteInfoController } from "./useBrowserSiteInfo";

export function SiteIdentity({
  info,
}: {
  info: NonNullable<BrowserSiteInfoController["info"]>;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 font-medium">
        {info.secure ? (
          <ShieldCheckIcon className="size-4 text-[var(--acc-green)]" />
        ) : (
          <GlobeIcon className="size-4 text-muted-foreground" />
        )}
        <span>
          {info.secure
            ? t("workspace.tools.browserSiteInformation.secureConnection", "Secure connection")
            : t(
                "workspace.tools.browserSiteInformation.connectionNotSecure",
                "Connection not secure",
              )}
        </span>
      </div>
      <p className="truncate font-mono text-xs text-muted-foreground">
        {info.origin ??
          t("workspace.tools.browserSiteInformation.noWebsiteOrigin", "No website origin")}
      </p>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {info.privacy === "private" ? <EyeOffIcon className="size-3.5" /> : null}
        <span>
          {info.privacy === "private"
            ? t("workspace.tools.browserSiteInformation.private", "Private")
            : info.privacy === "normal"
              ? t("workspace.tools.browserSiteInformation.normal", "Normal")
              : t("workspace.tools.browserSiteInformation.featureSession", "Feature session")}{" "}
          ·{" "}
          {info.profile.mode === "fresh"
            ? t("workspace.tools.browserSiteInformation.freshProfile", "Fresh ephemeral")
            : info.profile.mode === "feature"
              ? t("workspace.tools.browserSiteInformation.featureProfile", "Feature ephemeral")
              : info.profile.label}
        </span>
      </div>
    </div>
  );
}

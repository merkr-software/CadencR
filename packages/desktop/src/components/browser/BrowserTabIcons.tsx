import { useUiTranslation } from "@/lib/i18n/ui";
import { useState, type ReactElement } from "react";
import { GlobeIcon, KeyRoundIcon, Loader2Icon } from "lucide-react";
import type { BrowserTabMetadata } from "@/lib/desktop-bridge";
import { MAX_BROWSER_FAVICON_DATA_URL_LENGTH } from "@/shared/browser-types";

const SAFE_FAVICON_DATA_URL =
  /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/]+={0,2}$/iu;

export function BrowserPageIcon({ tab }: { tab: BrowserTabMetadata }): ReactElement {
  const { t } = useUiTranslation();
  if (tab.loading) {
    return (
      <span
        role="status"
        aria-label={t("workspace.tools.browserTabIcons.tabLoading", "Tab loading")}
      >
        <Loader2Icon aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-primary" />
      </span>
    );
  }
  if (isSafeFaviconDataUrl(tab.faviconUrl)) {
    return <BrowserFavicon key={tab.faviconUrl} url={tab.faviconUrl} />;
  }
  return <GlobeIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />;
}

export function BrowserTemporaryTabIcon(): ReactElement {
  const { t } = useUiTranslation();
  return (
    <span
      role="img"
      aria-label={t("workspace.tools.browserTabIcons.temporarySignInTab", "Temporary sign-in tab")}
      title={t(
        "workspace.tools.browserTabIcons.temporarySignInTabNotRestoredOr",
        "Temporary sign-in tab — not restored or reopened",
      )}
    >
      <KeyRoundIcon aria-hidden="true" className="size-3 shrink-0 text-[var(--acc-orange)]" />
    </span>
  );
}

function isSafeFaviconDataUrl(url: string | undefined): url is string {
  return Boolean(
    url && url.length <= MAX_BROWSER_FAVICON_DATA_URL_LENGTH && SAFE_FAVICON_DATA_URL.test(url),
  );
}

function BrowserFavicon({ url }: { url: string }): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) return <GlobeIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />;
  return (
    <img
      src={url}
      alt=""
      className="size-3.5 shrink-0 rounded-sm"
      onError={() => setFailed(true)}
    />
  );
}

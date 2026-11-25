import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function BrowserExternalButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      onClick={onClick}
      aria-label={t(
        "workspace.tools.browserExternalButton.openInDefaultBrowser",
        "Open in default browser",
      )}
      title={t(
        "workspace.tools.browserExternalButton.openInDefaultBrowserCookiesAndSignIn",
        "Open in default browser (cookies and sign-in state are not transferred)",
      )}
    >
      <ExternalLinkIcon className="size-4" />
    </Button>
  );
}

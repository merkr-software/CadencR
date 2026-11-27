import type { ReactElement } from "react";
import { HandIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUiTranslation } from "@/lib/i18n/ui";
import type { BrowserResponsiveRequest, BrowserTabMetadata } from "@/lib/desktop-bridge";
import { toBrowserResponsiveRequest } from "@/shared/browser-responsive";

export function ResponsiveTouchToggle({
  enabled,
  pending,
  onToggle,
}: {
  enabled: boolean;
  pending: boolean;
  onToggle: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <Button
      type="button"
      variant={enabled ? "secondary" : "ghost"}
      size="sm"
      disabled={pending}
      aria-label={t(
        "workspace.tools.browserResponsiveToolbar.emulateTouchInput",
        "Emulate touch input",
      )}
      aria-pressed={enabled}
      onClick={onToggle}
    >
      <HandIcon className="size-3.5" />{" "}
      {t("workspace.tools.browserResponsiveToolbar.touch", "Touch")}
    </Button>
  );
}

export function ResponsiveApplyActions({
  draft,
  responsive,
  invalid,
  pending,
  onApply,
}: {
  draft: BrowserResponsiveRequest;
  responsive: BrowserTabMetadata["responsive"];
  invalid: boolean;
  pending: boolean;
  onApply: (request: BrowserResponsiveRequest) => Promise<void>;
}): ReactElement {
  const { t } = useUiTranslation();
  const exitLabel = t(
    "workspace.tools.browserResponsiveToolbar.exitResponsiveMode",
    "Exit responsive mode",
  );
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="sm"
        disabled={pending || invalid}
        onClick={() => void onApply({ ...draft, enabled: true })}
      >
        {pending ? <Loader2Icon className="animate-spin" /> : null}{" "}
        {t("workspace.tools.browserResponsiveToolbar.apply", "Apply")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={pending}
        aria-label={exitLabel}
        title={exitLabel}
        onClick={() => void onApply({ ...toBrowserResponsiveRequest(responsive), enabled: false })}
      >
        <XIcon className="size-4" />
      </Button>
    </div>
  );
}

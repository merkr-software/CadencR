import { localizedBrowserError } from "@/shared/browser-error-copy";
import { useUiTranslation } from "@/lib/i18n/ui";
import { memo, type ReactElement } from "react";
import {
  AlertTriangleIcon,
  Loader2Icon,
  RotateCwIcon,
  ShieldAlertIcon,
  WifiOffIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BrowserTabError } from "@/lib/desktop-bridge";

interface BrowserPageErrorProps {
  error: BrowserTabError;
  onRetry: () => void;
  retrying?: boolean;
}

function PageErrorIcon({ kind }: { kind: BrowserTabError["kind"] }): ReactElement {
  switch (kind) {
    case "security":
      return <ShieldAlertIcon aria-hidden="true" className="size-6 text-[var(--acc-orange)]" />;
    case "load":
      return <WifiOffIcon aria-hidden="true" className="size-6 text-muted-foreground" />;
    case "crash":
    default:
      return <AlertTriangleIcon aria-hidden="true" className="size-6 text-destructive" />;
  }
}

export const BrowserPageError = memo(function BrowserPageError({
  error,
  onRetry,
  retrying = false,
}: BrowserPageErrorProps): ReactElement {
  const { t } = useUiTranslation();
  const { title, description } = localizedBrowserError(error, t);
  return (
    <div
      role="alert"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-background px-6 text-center"
    >
      <div className="flex max-w-md flex-col items-center gap-4">
        <div className="flex size-12 items-center justify-center rounded-full border border-border bg-muted">
          <PageErrorIcon kind={error.kind} />
        </div>
        <div className="space-y-1.5">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {error.url ? (
          <p
            title={error.url}
            className="max-w-full truncate rounded-md border border-border bg-muted/50 px-2.5 py-1 font-mono text-xs text-muted-foreground"
          >
            {error.url}
          </p>
        ) : null}
        {error.retryable !== false ? (
          <Button
            type="button"
            size="sm"
            onClick={onRetry}
            disabled={retrying}
            aria-busy={retrying}
          >
            {retrying ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <RotateCwIcon className="size-4" />
            )}
            {retrying
              ? t("workspace.tools.browserPageError.retrying", "Retrying…")
              : t("workspace.tools.browserPageError.tryAgain", "Try again")}
          </Button>
        ) : null}
        {error.code ? (
          <p className="font-mono text-[11px] text-muted-foreground/80">{error.code}</p>
        ) : null}
      </div>
    </div>
  );
});

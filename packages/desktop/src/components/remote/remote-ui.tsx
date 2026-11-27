import { useState, type ReactElement, type ReactNode } from "react";
import type { RemoteDevice } from "@/api/generated";
import { ChevronRight, Copy } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";
import { formatCompactAge, parseUTCDateTime } from "@/lib/date-utils";
import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";
import { CollapsibleSection } from "@/components/ui/collapsible-section";

/** A section's title inside the remote dialog; `id` names its section (`aria-labelledby`). */
export function SectionHeading({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}): ReactElement {
  return (
    <h3 id={id} className="text-sm font-semibold">
      {children}
    </h3>
  );
}

/** What a paired device is called wherever the dialog names it. */
export function deviceLabel(device: Pick<RemoteDevice, "label">, t: UiTranslator): string {
  return device.label ?? t("remote.devices.unnamed", "Remote device");
}

/**
 * Collapsed-by-default disclosure card for the secondary remote-access sections
 * (certificate, tunnel, devices, activity). Keeps the dialog focused on the
 * primary connect/pair flow — the advanced material expands only on demand.
 */
export function RemoteDisclosure({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = (): void => setOpen((current) => !current);
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted/50",
          open ? "rounded-t-lg" : "rounded-lg",
        )}
      >
        <span>{title}</span>
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-90",
          )}
          aria-hidden
        />
      </button>
      <CollapsibleSection open={open}>
        <div className="border-t border-border px-3 py-3">{children}</div>
      </CollapsibleSection>
    </div>
  );
}

/** Icon-only "copy to clipboard" button with a success toast. */
export function CopyIconButton({
  value,
  successLabel,
  className,
}: {
  value: string;
  successLabel: ReactNode;
  className?: string;
}): ReactElement {
  const { t } = useUiTranslation();
  const label = t("common.copy", "Copy");
  return (
    <button
      type="button"
      onClick={() => void copyToClipboard(value, successLabel)}
      title={label}
      className={cn(
        "shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
    >
      <Copy className="size-3.5" aria-hidden />
      <span className="sr-only">{label}</span>
    </button>
  );
}

/**
 * Format a SQLite `datetime('now')` timestamp ("YYYY-MM-DD HH:MM:SS", UTC, no
 * zone marker) as a coarse relative age. Falls back to the raw value if it
 * doesn't parse.
 */
export function formatRemoteAge(
  value: string | null | undefined,
  t: UiTranslator,
  locale: string,
): string {
  if (!value) return t("remote.age.never", "never");
  const ms = parseUTCDateTime(value).getTime();
  if (Number.isNaN(ms)) return value;
  return formatCompactAge(ms, t, locale, { showDays: true });
}

import { cn } from "@/lib/utils";
import type { CustomTabStatus } from "./custom-tab-model";

const STATUS_LABEL: Record<CustomTabStatus, string> = {
  blocked: "Blocked",
  valid: "Valid",
  invalid: "Invalid",
  unavailable: "Unavailable",
  "not-built": "Not built",
};

// Literal class strings: Tailwind only emits arbitrary values it finds verbatim.
const STATUS_CLASS: Record<CustomTabStatus, string> = {
  blocked: "bg-[color-mix(in_oklab,var(--acc-red)_14%,transparent)] text-[var(--acc-red)]",
  valid: "bg-[color-mix(in_oklab,var(--acc-green)_14%,transparent)] text-[var(--acc-green)]",
  invalid: "bg-[color-mix(in_oklab,var(--acc-red)_14%,transparent)] text-[var(--acc-red)]",
  // Nothing to fix on this computer: it informs, it does not alarm.
  unavailable: "bg-muted text-muted-foreground",
  "not-built":
    "bg-[color-mix(in_oklab,var(--acc-orange)_14%,transparent)] text-[var(--acc-orange)]",
};

/**
 * Valid (ready), Invalid or Blocked (blocking), Not built (in progress) — DESIGN.md status
 * colors — or Unavailable on this platform (muted: nothing to act on here; the
 * card says which platforms it runs on).
 */
export function CustomTabStatusBadge({ status }: { status: CustomTabStatus }): React.JSX.Element {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
        STATUS_CLASS[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

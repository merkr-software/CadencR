import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A horizontal row inside a `SettingsCard`. Layout: optional leading icon
 * (`IconTile`), then a label + description block, then a trailing slot for
 * the control (switch, button, stepper, etc.).
 *
 * Rows stack with a top border via the `divided` prop — pass `divided`
 * for every row except the first inside a card.
 *
 * Use `align="start"` when the description wraps to multiple lines; keep
 * the default `center` for short-label rows where the control is a switch.
 */
export function SettingsRow({
  icon,
  label,
  description,
  control,
  divided = false,
  align = "center",
  className,
  htmlFor,
}: {
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  divided?: boolean;
  align?: "center" | "start";
  className?: string;
  htmlFor?: string;
}): React.JSX.Element {
  const labelContent = (
    <>
      <div className="text-sm font-medium leading-tight">{label}</div>
      {description ? (
        <p className="mt-0.5 max-w-md text-xs text-muted-foreground leading-snug">{description}</p>
      ) : null}
    </>
  );

  return (
    <div
      className={cn(
        // The control drops under its label once the row can't fit both side
        // by side (phones, narrow cards, a wide control).
        "flex flex-wrap gap-x-6 gap-y-3 px-5 py-4",
        align === "center" ? "items-center" : "items-start",
        divided && "border-t border-border",
        className,
      )}
    >
      {/* A min-width, not a flex-basis: rows that switch to flex-col would turn a
          basis into a 240px-tall label block. */}
      <div className="flex min-w-[min(15rem,100%)] flex-1 items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          {htmlFor ? (
            <label htmlFor={htmlFor} className="cursor-pointer">
              {labelContent}
            </label>
          ) : (
            labelContent
          )}
        </div>
      </div>
      {control ? <div className="flex shrink-0 items-center gap-2">{control}</div> : null}
    </div>
  );
}

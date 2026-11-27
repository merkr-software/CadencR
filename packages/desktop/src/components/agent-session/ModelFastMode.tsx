import { useUiTranslation } from "@/lib/i18n/ui";
import { Loader2Icon, ZapIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { cn } from "@/lib/utils";

export function FastModeSegment({
  enabled,
  pending,
  onToggle,
  instrument = false,
}: {
  enabled: boolean;
  pending: boolean;
  onToggle: () => void;
  instrument?: boolean;
}): ReactNode {
  const { t } = useUiTranslation();
  const stateLabel = enabled
    ? t("conversation.stream.modelMetaChip.on", "On")
    : t("conversation.stream.modelMetaChip.off", "Off");
  const status = t("conversation.stream.modelMetaChip.fastMode", "Fast mode: {{stateLabel}}", {
    stateLabel,
  });
  const action = enabled
    ? t("conversation.stream.modelMetaChip.disableFastMode", "Turn fast mode off")
    : t("conversation.stream.modelMetaChip.enableFastMode", "Turn fast mode on");
  const label = t("conversation.stream.modelMetaChip.fast", "Fast");
  if (instrument) {
    return (
      <FastModeInstrument
        enabled={enabled}
        pending={pending}
        onToggle={onToggle}
        status={status}
        action={action}
        label={label}
      />
    );
  }
  return (
    <>
      <div className="w-px bg-[var(--chip-violet-soft)]/15" aria-hidden="true" />
      <ShortcutTooltip label={status}>
        <button
          type="button"
          onClick={onToggle}
          disabled={pending}
          aria-label={action}
          aria-pressed={enabled}
          aria-busy={pending}
          data-state={enabled ? "on" : "off"}
          className={cn(
            "inline-flex h-full items-center gap-1.5 px-2.5 transition-colors",
            // Model chip stays on --chip-violet-* (DESIGN.md). Never theme
            // --primary here — on Frost that paints cyan/blue into a violet
            // control. ON is a charged violet cell: dense fill, bright soft
            // ink, inset hairline + outer glow so it reads as lit, not tinted.
            "rounded-r-md px-2 disabled:cursor-wait",
            enabled
              ? "bg-[var(--chip-violet-bg)]/70 font-semibold text-[var(--chip-violet-soft)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--chip-violet-soft)_65%,transparent),0_0_22px_-1px_color-mix(in_oklch,var(--chip-violet-bg)_75%,transparent)] hover:bg-[var(--chip-violet-bg)]/80"
              : "text-[var(--chip-violet-soft)]/35 hover:bg-[var(--chip-violet-bg)]/10 hover:text-[var(--chip-violet-soft)]/70",
          )}
        >
          {pending ? (
            <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
          ) : (
            <ZapIcon
              className={cn(
                "size-3 shrink-0 transition-[filter,color] duration-150",
                enabled &&
                  "fill-current text-[var(--chip-violet-soft)] drop-shadow-[0_0_6px_color-mix(in_oklch,var(--chip-violet-soft)_85%,transparent)]",
              )}
              aria-hidden="true"
            />
          )}
          <span
            aria-hidden="true"
            className={cn("@max-[40rem]:hidden", enabled && "tracking-wide")}
          >
            {label}
          </span>
        </button>
      </ShortcutTooltip>
    </>
  );
}

/**
 * Fast mode in the composer's instrument row: a lit amber bolt when on, a
 * quiet outline when off — no charged chip.
 */
function FastModeInstrument({
  enabled,
  pending,
  onToggle,
  status,
  action,
  label,
}: {
  enabled: boolean;
  pending: boolean;
  onToggle: () => void;
  status: string;
  action: string;
  label: string;
}): ReactNode {
  return (
    <ShortcutTooltip label={status}>
      <button
        type="button"
        onClick={onToggle}
        disabled={pending}
        aria-label={action}
        aria-pressed={enabled}
        aria-busy={pending}
        data-state={enabled ? "on" : "off"}
        className={cn(
          "composer-instrument gap-1 disabled:cursor-wait",
          enabled ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {pending ? (
          <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <ZapIcon
            className={cn(
              "size-3.5 shrink-0",
              enabled && "fill-current text-[var(--acc-yellow)] composer-fast-lit",
            )}
            aria-hidden="true"
          />
        )}
        <span aria-hidden="true" className="@max-[26rem]:hidden">
          {label}
        </span>
      </button>
    </ShortcutTooltip>
  );
}

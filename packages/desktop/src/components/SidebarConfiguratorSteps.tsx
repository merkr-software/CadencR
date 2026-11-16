import { useId, type ReactElement, type ReactNode } from "react";
import type { SidebarDisplayForm } from "@/components/SidebarDisplayOptions";
import { SidebarPresetPicker } from "@/components/SidebarPresetPicker";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { cn } from "@/lib/utils";

/**
 * The display options as two steps, so a preset reads as the base the options
 * modify rather than as one more option: pick a preset, then adjust it (the
 * option groups, passed as children). `wide` is the Settings page's layout,
 * the popover's otherwise.
 */
export function SidebarConfiguratorSteps({
  form,
  wide = false,
  children,
}: {
  form: SidebarDisplayForm;
  wide?: boolean;
  children: ReactNode;
}): ReactElement {
  const presetHeading = useId();
  const adjustHeading = useId();
  const picker = <SidebarPresetPicker form={form} wide={wide} />;
  return (
    <>
      <section aria-labelledby={presetHeading} className="flex flex-col gap-2.5">
        <StepHeading
          id={presetHeading}
          step={1}
          title="Preset"
          detail="The base every option starts from"
          wide={wide}
        />
        {wide ? <SettingsCard className="p-4">{picker}</SettingsCard> : picker}
      </section>
      <section
        aria-labelledby={adjustHeading}
        className={cn(
          "flex flex-col border-t border-border/60",
          wide ? "gap-5 pt-5" : "gap-3 pt-3",
        )}
      >
        <StepHeading
          id={adjustHeading}
          step={2}
          title="Adjust"
          detail={`On top of ${form.nearest.preset.label}`}
          wide={wide}
        />
        {children}
      </section>
    </>
  );
}

function StepHeading({
  id,
  step,
  title,
  detail,
  wide,
}: {
  id: string;
  step: number;
  title: string;
  detail: string;
  wide: boolean;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-2 px-0.5">
      <span
        aria-hidden
        className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold tabular-nums text-primary"
      >
        {step}
      </span>
      <h3
        id={id}
        className={cn(
          "shrink-0 font-semibold tracking-tight text-foreground",
          wide ? "text-sm" : "text-xs",
        )}
      >
        {title}
      </h3>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground">{detail}</span>
    </div>
  );
}

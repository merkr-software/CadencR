import type { ReactElement } from "react";
import { Check, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HintTooltip } from "@/components/HintTooltip";
import { SidebarPresetSketch } from "@/components/SidebarPresetSketch";
import type { SidebarDisplayForm } from "@/components/SidebarDisplayOptions";
import { SIDEBAR_PRESETS, type SidebarPreset } from "@/lib/sidebar-presets";
import { cn } from "@/lib/utils";

type PresetForm = Pick<SidebarDisplayForm, "config" | "nearest" | "applyPreset" | "restore">;

/** One undo toast at a time: a newer preset replaces the older one's. */
const UNDO_TOAST_ID = "sidebar-preset-undo";

/**
 * The presets as cards, each drawn as the sidebar it makes, with a line that
 * names the current state: a preset, or how far the options moved from one.
 * Applying a preset over customized options can be undone from its toast.
 * `wide` lays the four side by side (Settings); the popover takes two by two.
 */
export function SidebarPresetPicker({
  form,
  wide = false,
}: {
  form: PresetForm;
  wide?: boolean;
}): ReactElement {
  const { preset: base, changes } = form.nearest;

  const apply = (preset: SidebarPreset, title: string): void => {
    if (changes === 0 && preset.id === base.id) return;
    const previous = form.config;
    form.applyPreset(preset.id);
    if (changes === 0) return;
    toast(title, {
      id: UNDO_TOAST_ID,
      description: "It replaced your customized display options.",
      duration: 10_000,
      action: { label: "Undo", onClick: () => form.restore(previous) },
    });
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col gap-2">
        <div
          role="radiogroup"
          aria-label="Preset"
          className={cn("grid gap-2", wide ? "grid-cols-4 @max-xl:grid-cols-2" : "grid-cols-2")}
        >
          {SIDEBAR_PRESETS.map((preset) => (
            <HintTooltip key={preset.id} hint={preset.description}>
              <button
                type="button"
                role="radio"
                aria-checked={changes === 0 && preset.id === base.id}
                data-preset={preset.id}
                data-preset-state={
                  preset.id !== base.id ? "idle" : changes > 0 ? "base" : "selected"
                }
                onClick={() => apply(preset, `${preset.label} applied`)}
                className="group/preset relative flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/60 p-1.5 text-left outline-none transition-colors hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60 data-[preset-state=base]:border-dashed data-[preset-state=base]:border-primary/50 data-[preset-state=selected]:border-primary/70 data-[preset-state=selected]:bg-primary/[0.07]"
              >
                <SidebarPresetSketch config={preset.config} className={wide ? "h-16" : "h-14"} />
                <span className="flex min-w-0 flex-col px-0.5 pb-0.5">
                  <span className="flex items-center gap-1 text-xs font-semibold text-foreground">
                    <span className="truncate">{preset.label}</span>
                    <Check className="ml-auto hidden size-3.5 shrink-0 text-primary group-data-[preset-state=selected]/preset:block" />
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {preset.tagline}
                  </span>
                </span>
              </button>
            </HintTooltip>
          ))}
        </div>
        <PresetStatusLine
          preset={base}
          changes={changes}
          onRevert={() => apply(base, `Back to ${base.label}`)}
        />
      </div>
    </TooltipProvider>
  );
}

/** The current state in words: the preset's description, or "Custom" and the way back. */
function PresetStatusLine({
  preset,
  changes,
  onRevert,
}: {
  preset: SidebarPreset;
  changes: number;
  onRevert: () => void;
}): ReactElement {
  if (changes === 0) {
    return (
      <p className="px-0.5 text-[11px] leading-snug text-muted-foreground">
        <span className="font-medium text-foreground/85">{preset.label}.</span> {preset.description}
      </p>
    );
  }
  return (
    <div
      role="status"
      className="flex min-h-7 items-center gap-2 rounded-md border border-dashed border-primary/40 bg-primary/[0.05] py-0.5 pl-2 pr-0.5 text-[11px] text-muted-foreground"
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground/90">Custom</span> · {preset.label} with{" "}
        {changes} {changes === 1 ? "change" : "changes"}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={onRevert}
        className="shrink-0 text-[11px] text-foreground/85"
      >
        <Undo2 />
        Back to {preset.label}
      </Button>
    </div>
  );
}

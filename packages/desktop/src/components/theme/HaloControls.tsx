import { useCallback, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { Slider } from "@/components/ui/slider";
import { RadioCardGroup } from "@/components/settings/RadioCardGroup";
import { useHaloOverride } from "@/hooks/useHaloOverride";
import { chromeOf } from "@/lib/themes/chrome";
import { readHaloPalette, type HaloPaletteEntry } from "@/lib/themes/halo-palette";
import {
  glowSeconds,
  HALO_MOTION_LABELS,
  HALO_MOTIONS,
  INTENSITY_RANGE,
  isDefaultOverride,
  lavaSpeed,
  ROTATION_RANGE,
  SPEED_RANGE,
  type HaloOverride,
  type ThemeDefinition,
} from "@/lib/themes";
import { cn } from "@/lib/utils";

/**
 * Retuning the active theme's halos, live.
 *
 * Only rendered for a theme that declares halos — that is the whole
 * compatibility test, and it needs no per-theme list: Frost, Catppuccin Frost
 * and anything published later qualify by having a texture, and a theme with
 * only grain or an image never sees this panel.
 *
 * The tuning is a transform stored beside the theme (`useHaloOverride`), never
 * an edit of the theme file, so it works the same for a built-in, a
 * marketplace theme and one the user wrote.
 *
 * `theme` and `isLoading` come from the drawer rather than a second `useTheme`:
 * that hook carries a system-appearance round-trip and four settings
 * subscriptions, and the drawer already paid for them.
 */
export function HaloControls({
  theme,
  isLoading: isThemeLoading,
}: {
  theme: ThemeDefinition;
  isLoading: boolean;
}): React.JSX.Element | null {
  const { override, setOverride, reset, error, isLoading, isSaving } = useHaloOverride(theme.id);
  const halos = chromeOf(theme).texture.halos;
  const [open, setOpen] = useState(false);

  if (halos.length === 0) return null;

  const busy = isLoading || isThemeLoading;

  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium"
        >
          <ChevronDown
            className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")}
          />
          <span className="truncate">Halos</span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground">{halos.length}</span>
        </button>
        {isDefaultOverride(override) ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1 text-xs"
            onClick={reset}
            disabled={busy}
          >
            <RotateCcw className="size-3" />
            Reset
          </Button>
        )}
      </div>

      <CollapsibleSection open={open}>
        {/* Keyed on the theme so switching themes drops an open palette rather
         * than leaving the previous theme's swatches on screen. */}
        <HaloControlsBody
          key={theme.id}
          override={override}
          halos={halos}
          disabled={busy}
          isSaving={isSaving}
          error={error}
          onChange={setOverride}
        />
      </CollapsibleSection>
    </div>
  );
}

interface HaloControlsBodyProps {
  override: HaloOverride;
  halos: { color: string }[];
  disabled: boolean;
  isSaving: boolean;
  error: string | null;
  onChange: (next: HaloOverride) => void;
}

function HaloControlsBody({
  override,
  halos,
  disabled,
  isSaving,
  error,
  onChange,
}: HaloControlsBodyProps): React.JSX.Element {
  const [palette, setPalette] = useState<HaloPaletteEntry[]>([]);
  const [paletteFor, setPaletteFor] = useState<number | null>(null);

  /**
   * Read the palette when a row opens, never during render.
   *
   * The active theme reaches `<html>` from an effect that runs *after* this
   * component renders, so a render-time read hands back the previous theme's
   * tokens. By the time a click arrives, the document is settled.
   */
  const togglePalette = useCallback(
    (index: number): void => {
      if (paletteFor === index) {
        setPaletteFor(null);
        return;
      }
      setPalette(readHaloPalette(document.documentElement));
      setPaletteFor(index);
    },
    [paletteFor],
  );

  const setColor = useCallback(
    (index: number, color: string | null): void => {
      const colors = [...override.colors];
      while (colors.length <= index) colors.push(null);
      colors[index] = color;
      onChange({ ...override, colors });
    },
    [onChange, override],
  );

  return (
    <div className="space-y-4 border-t border-border px-4 py-3">
      <p className="text-xs text-muted-foreground">
        Tunes this theme only. The theme file is left untouched.
      </p>

      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-muted-foreground">Motion</span>
        <RadioCardGroup
          value={override.motion}
          onChange={(motion) => onChange({ ...override, motion })}
          ariaLabel="Halo motion"
          layout="grid"
          columns={2}
          showDot={false}
          disabled={disabled}
          className="grid grid-cols-2 gap-1.5"
          options={HALO_MOTIONS.map((motion) => ({
            value: motion,
            label: HALO_MOTION_LABELS[motion],
          }))}
        />
      </div>

      <TuningSliders override={override} disabled={disabled} onChange={onChange} />

      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-muted-foreground">Colors</span>
        {halos.map((halo, index) => (
          <HaloColorRow
            key={index}
            index={index}
            color={override.colors[index] ?? halo.color}
            picked={override.colors[index] ?? null}
            palette={palette}
            open={paletteFor === index}
            disabled={disabled}
            onToggle={() => togglePalette(index)}
            onPick={(color) => setColor(index, color)}
          />
        ))}
      </div>

      {error === null ? null : (
        <p className="text-xs text-destructive" role="alert">
          Could not read the saved tuning: {error}. Your next change replaces it.
        </p>
      )}

      {isSaving ? (
        <p className="text-xs text-muted-foreground" role="status">
          Saving…
        </p>
      ) : null}
    </div>
  );
}

/**
 * The three numbers, in the order they matter.
 *
 * A fixed angle and a moving field answer the same question, so only one of the
 * first two is ever live — the other is greyed rather than hidden, so the
 * relationship stays visible.
 */
function TuningSliders({
  override,
  disabled,
  onChange,
}: {
  override: HaloOverride;
  disabled: boolean;
  onChange: (next: HaloOverride) => void;
}): React.JSX.Element {
  return (
    <>
      <SliderRow
        label="Orientation"
        value={`${override.rotation}°`}
        range={ROTATION_RANGE}
        current={override.rotation}
        disabled={disabled || override.motion !== "still"}
        onChange={(rotation) => onChange({ ...override, rotation })}
      />

      <SliderRow
        label="Speed"
        value={speedLabel(override)}
        range={SPEED_RANGE}
        current={override.speed}
        disabled={disabled || override.motion === "still"}
        onChange={(speed) => onChange({ ...override, speed })}
      />

      <SliderRow
        label="Intensity"
        value={`${Math.round(override.intensity * 100)}%`}
        range={INTENSITY_RANGE}
        current={override.intensity}
        disabled={disabled}
        onChange={(intensity) => onChange({ ...override, intensity })}
      />
    </>
  );
}

/**
 * What the speed slider means right now.
 *
 * The pace is one number, but each motion spends it differently — degrees per
 * second, `vw` per second, seconds per breath — so the panel prints the unit
 * the current motion actually uses rather than a number with no meaning. The
 * conversions come from the same functions the renderer uses, so the label
 * cannot drift from the motion.
 */
function speedLabel(override: HaloOverride): string {
  switch (override.motion) {
    case "orbit":
      return `${override.speed}°/s`;
    case "lava":
      return `${lavaSpeed(override)?.toFixed(1)} vw/s`;
    case "glow":
      return `${glowSeconds(override)?.toFixed(1)}s`;
    default:
      return "—";
  }
}

interface SliderRowProps {
  label: string;
  value: string;
  range: { min: number; max: number; step: number };
  current: number;
  disabled: boolean;
  onChange: (value: number) => void;
}

function SliderRow({
  label,
  value,
  range,
  current,
  disabled,
  onChange,
}: SliderRowProps): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="font-mono text-xs tabular-nums">{value}</span>
      </div>
      <Slider
        min={range.min}
        max={range.max}
        step={range.step}
        value={[current]}
        disabled={disabled}
        onValueChange={([next]) => onChange(next)}
        aria-label={label}
      />
    </div>
  );
}

interface HaloColorRowProps {
  index: number;
  color: string;
  /** The color the user picked, or `null` while the halo wears the theme's. */
  picked: string | null;
  palette: HaloPaletteEntry[];
  open: boolean;
  disabled: boolean;
  onToggle: () => void;
  onPick: (color: string | null) => void;
}

function HaloColorRow({
  index,
  color,
  picked,
  palette,
  open,
  disabled,
  onToggle,
  onPick,
}: HaloColorRowProps): React.JSX.Element {
  const label = `Halo ${index + 1}`;
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${label} color`}
        disabled={disabled}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-accent disabled:opacity-50"
      >
        <span
          className="size-4 shrink-0 rounded-full border border-border"
          style={{ backgroundColor: color }}
        />
        <span className="flex-1 truncate">{label}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {picked === null ? "theme" : "custom"}
        </span>
      </button>

      <CollapsibleSection open={open}>
        <div className="space-y-2 px-1 pb-1">
          <div className="grid grid-cols-6 gap-1.5" role="group" aria-label={`${label} palette`}>
            {palette.map((entry) => (
              <button
                key={entry.token}
                type="button"
                onClick={() => onPick(entry.color)}
                aria-label={`${label}: ${entry.token}`}
                aria-pressed={entry.color === picked}
                title={entry.token}
                className={cn(
                  "size-6 rounded-md border transition-transform hover:scale-110",
                  entry.color === picked
                    ? "border-foreground ring-2 ring-foreground/40"
                    : "border-border",
                )}
                style={{ backgroundColor: entry.color }}
              />
            ))}
          </div>
          {picked === null ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1 text-xs"
              onClick={() => onPick(null)}
            >
              Use the theme's color
            </Button>
          )}
        </div>
      </CollapsibleSection>
    </div>
  );
}

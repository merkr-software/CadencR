import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { readHaloPalette, type HaloPaletteEntry } from "@/lib/themes/halo-palette";
import type { HaloOverride, ThemeDefinition } from "@/lib/themes";
import { cn } from "@/lib/utils";

export function HaloColorControls({
  theme,
  halos,
  override,
  disabled,
  onChange,
}: {
  theme: ThemeDefinition;
  halos: { color: string }[];
  override: HaloOverride;
  disabled: boolean;
  onChange: (next: HaloOverride) => void;
}): React.JSX.Element {
  const [palette, setPalette] = useState<HaloPaletteEntry[]>([]);
  const [paletteFor, setPaletteFor] = useState<number | null>(null);

  // A same-ID live edit replaces the definition without remounting the row.
  // Read its new tokens on the next opening, after theme application finishes.
  useEffect(() => setPaletteFor(null), [theme]);

  // Theme application runs after render. Read the palette only when a row
  // opens, once the document carries the current theme's tokens.
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
      <Button
        type="button"
        variant="ghost"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${label} color`}
        disabled={disabled}
        className="h-auto w-full justify-start px-1 py-1 text-left text-xs"
      >
        <span
          className="size-4 shrink-0 rounded-full border border-border"
          style={{ backgroundColor: color }}
        />
        <span className="flex-1 truncate">{label}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {picked === null ? "theme" : "custom"}
        </span>
      </Button>

      <CollapsibleSection open={open}>
        <div className="space-y-2 px-1 pb-1">
          <div className="grid grid-cols-6 gap-1.5" role="group" aria-label={`${label} palette`}>
            {palette.map((entry) => (
              <Button
                key={entry.token}
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onPick(entry.color)}
                aria-label={`${label}: ${entry.token}`}
                disabled={disabled}
                aria-pressed={entry.color === picked}
                title={entry.token}
                className={cn(
                  "size-6 border p-0 transition-transform hover:scale-110",
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
              disabled={disabled}
            >
              Use the theme's color
            </Button>
          )}
        </div>
      </CollapsibleSection>
    </div>
  );
}

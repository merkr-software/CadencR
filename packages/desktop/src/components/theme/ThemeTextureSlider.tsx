import { Slider } from "@/components/ui/slider";

interface ThemeTextureSliderProps {
  label: string;
  value: string;
  range: { min: number; max: number; step: number };
  current: number;
  disabled: boolean;
  onChange: (value: number) => void;
}

export function ThemeTextureSlider({
  label,
  value,
  range,
  current,
  disabled,
  onChange,
}: ThemeTextureSliderProps): React.JSX.Element {
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

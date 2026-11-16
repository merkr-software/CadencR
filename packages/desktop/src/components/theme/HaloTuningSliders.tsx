import { ThemeTextureSlider } from "./ThemeTextureSlider";
import {
  glowSeconds,
  INTENSITY_RANGE,
  lavaSpeed,
  ROTATION_RANGE,
  SPEED_RANGE,
  type HaloOverride,
} from "@/lib/themes";

/**
 * The three numbers, in the order they matter.
 *
 * Orientation sets the composition for still and glowing fields. Circular and
 * lava own their positions; speed is only useful while an animation is active.
 */
export function HaloTuningSliders({
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
      <ThemeTextureSlider
        label="Orientation"
        value={`${override.rotation}°`}
        range={ROTATION_RANGE}
        current={override.rotation}
        disabled={disabled || (override.motion !== "still" && override.motion !== "glow")}
        onChange={(rotation) => onChange({ ...override, rotation })}
      />

      <ThemeTextureSlider
        label="Speed"
        value={speedLabel(override)}
        range={SPEED_RANGE}
        current={override.speed}
        disabled={disabled || override.motion === "still"}
        onChange={(speed) => onChange({ ...override, speed })}
      />

      <ThemeTextureSlider
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

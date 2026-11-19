import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * A single-thumb range control.
 *
 * Built on Radix rather than `<input type="range">` for the same reason the
 * other primitives are: keyboard handling, `aria-valuetext` and the thumb's
 * focus ring come out consistent with the rest of the app, and the track can be
 * themed with the same tokens.
 *
 * `aria-label` is forwarded to the *thumb*, which is the element carrying
 * `role="slider"` — on the root it would name a plain span and leave the
 * control itself unlabelled. `aria-disabled` goes with it for the same reason:
 * Radix marks the thumb with `data-disabled` only, which styles it but tells a
 * screen reader nothing.
 */
function Slider({
  className,
  value,
  disabled,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>): React.JSX.Element {
  const thumbCount = Array.isArray(value) ? value.length : 1;
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      disabled={disabled}
      className={cn(
        "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-1 w-full grow overflow-hidden rounded-full bg-control-border"
      >
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbCount }, (_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          data-slot="slider-thumb"
          aria-label={ariaLabel}
          aria-disabled={disabled || undefined}
          className="block size-3.5 shrink-0 rounded-full border border-primary bg-background shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-control-focus-ring disabled:pointer-events-none"
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };

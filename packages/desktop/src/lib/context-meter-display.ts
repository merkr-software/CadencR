/**
 * How the composer's context meter reads, cycled by clicking it. A global
 * workspace setting, so every conversation shows the same meter.
 */
export const CONTEXT_METER_DISPLAY_SETTING_KEY = "composer_context_meter_display";

export const CONTEXT_METER_DISPLAYS = ["bar_percent", "percent", "tokens", "left", "bar"] as const;

export type ContextMeterDisplay = (typeof CONTEXT_METER_DISPLAYS)[number];

export const DEFAULT_CONTEXT_METER_DISPLAY: ContextMeterDisplay = "bar_percent";

export const CONTEXT_METER_DISPLAY_LABEL: Record<ContextMeterDisplay, string> = {
  bar_percent: "Bar + percentage",
  percent: "Percentage",
  tokens: "Used / window",
  left: "Tokens left",
  bar: "Bar only",
};

export function parseContextMeterDisplay(value: string | null | undefined): ContextMeterDisplay {
  return CONTEXT_METER_DISPLAYS.includes(value as ContextMeterDisplay)
    ? (value as ContextMeterDisplay)
    : DEFAULT_CONTEXT_METER_DISPLAY;
}

export function nextContextMeterDisplay(display: ContextMeterDisplay): ContextMeterDisplay {
  const index = CONTEXT_METER_DISPLAYS.indexOf(display);
  return CONTEXT_METER_DISPLAYS[(index + 1) % CONTEXT_METER_DISPLAYS.length];
}

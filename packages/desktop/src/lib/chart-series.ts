/**
 * Categorical series colors for every chart in the app (usage statistics and
 * agent-drawn visuals), as theme token names in fixed assignment order.
 *
 * Drawn only from the design system's own `--chart-*` ramp, so charts
 * re-theme with every Cadencr theme instead of pinning hexes.
 *
 * Four slots, not five: `--chart-3` had to be dropped. Every theme restates the
 * whole ramp, so the hues below are the Cadencr brand theme's — there
 * `--chart-3` (leafy green) sits too close to both `--chart-1` (emerald) and
 * `--chart-5` (amber) to be told apart, the green/amber pair scoring a
 * normal-vision ΔE of ~12, under the 15 floor, before colorblindness enters
 * into it. Cutting the series count is the correct response to that, not
 * inventing a hue outside the system.
 *
 * The remaining order — emerald → blue → pink → amber in that theme — keeps
 * every adjacent pair above the deutan/protan floor (worst pair ΔE 10.3 dark,
 * 12.0 light).
 *
 * Ranks past the fourth series never get a generated fifth hue; they fold into
 * `OTHER_SERIES_TOKEN`.
 */
export const CHART_SERIES_TOKENS = ["chart-1", "chart-4", "chart-2", "chart-5"] as const;

/** The folded tail. Deliberately colorless — it is a bucket, not an entity. */
export const OTHER_SERIES_TOKEN = "muted-foreground";

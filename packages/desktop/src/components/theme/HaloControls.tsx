import { useId, useMemo, useState } from "react";
import { ChevronDown, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { Switch } from "@/components/ui/switch";
import { RadioCardGroup } from "@/components/settings/RadioCardGroup";
import { useHaloOverride } from "@/hooks/useHaloOverride";
import { chromeOf } from "@/lib/themes/chrome";
import { halosEnabled, halosFor, usesFallbackTexture } from "@/lib/themes/halo-composition";
import { grainOpacity, GRAIN_OPACITY_RANGE } from "@/lib/themes/grain-override";
import {
  HALO_MOTION_LABELS,
  HALO_MOTIONS,
  isDefaultOverride,
  VEIL_RANGE,
  type HaloOverride,
  type ThemeDefinition,
} from "@/lib/themes";
import { cn } from "@/lib/utils";
import { HaloColorControls } from "./HaloColorControls";
import { HaloCountControl } from "./HaloCountControl";
import { HaloTuningSliders } from "./HaloTuningSliders";
import { ThemeTextureSlider } from "./ThemeTextureSlider";

/** Every theme has a field to tune; themes without authored halos start off. */
export function HaloControls({
  theme,
  isLoading: isThemeLoading,
}: {
  theme: ThemeDefinition;
  isLoading: boolean;
}): React.JSX.Element {
  const { override, setOverride, reset, retry, error, canEdit, isLoading, isSaving } =
    useHaloOverride(theme.id);
  const texture = chromeOf(theme).texture;
  const count = override.count;
  const appearance = theme.appearance;
  const halos = useMemo(() => halosFor(texture, count, appearance), [texture, count, appearance]);
  const enabled = halosEnabled(texture, override.enabled);
  const [open, setOpen] = useState(false);
  const busy = isLoading || isThemeLoading;
  const disabled = busy || !canEdit;

  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="h-auto min-w-0 flex-1 justify-start px-1 py-0 text-sm font-medium"
        >
          <ChevronDown
            className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")}
          />
          <span className="truncate">Halos</span>
          <span className="shrink-0 text-xs font-normal text-muted-foreground">
            {enabled ? halos.length : "Off"}
          </span>
        </Button>
        {busy || isSaving ? (
          <span role="status" aria-label={busy ? "Loading halo settings" : "Saving halo settings"}>
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
            <span className="sr-only">{busy ? "Loading…" : "Saving…"}</span>
          </span>
        ) : null}
        {isDefaultOverride(override) ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1 text-xs"
            onClick={reset}
            disabled={disabled}
          >
            <RotateCcw className="size-3" />
            Reset
          </Button>
        )}
      </div>

      <CollapsibleSection open={open}>
        {/* Drop an open palette when switching themes. */}
        <HaloControlsBody
          key={theme.id}
          theme={theme}
          override={override}
          halos={halos}
          grain={grainOpacity(texture, override.grainOpacity)}
          enabled={enabled}
          hasVeil={texture.veil || usesFallbackTexture(texture, override)}
          disabled={disabled}
          canEdit={canEdit}
          error={error}
          onChange={setOverride}
          onRetry={retry}
        />
      </CollapsibleSection>
    </div>
  );
}

interface HaloControlsBodyProps {
  theme: ThemeDefinition;
  override: HaloOverride;
  halos: { color: string }[];
  grain: number;
  enabled: boolean;
  hasVeil: boolean;
  disabled: boolean;
  canEdit: boolean;
  error: string | null;
  onChange: (next: HaloOverride) => void;
  onRetry: () => void;
}

function HaloControlsBody({
  theme,
  override,
  halos,
  grain,
  enabled,
  hasVeil,
  disabled,
  canEdit,
  error,
  onChange,
  onRetry,
}: HaloControlsBodyProps): React.JSX.Element {
  const enabledId = useId();
  const tuningDisabled = disabled || !enabled;

  return (
    <div className="space-y-4 border-t border-border px-4 py-3">
      <HaloSettingsError error={error} canEdit={canEdit} onRetry={onRetry} />
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={enabledId} className="text-xs font-medium">
          Enable halos
        </label>
        <Switch
          id={enabledId}
          size="sm"
          checked={enabled}
          onCheckedChange={(enabled) => onChange({ ...override, enabled })}
          disabled={disabled}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Tunes this theme only. The theme file is left untouched.
      </p>

      <HaloCountControl
        count={halos.length}
        disabled={tuningDisabled}
        onChange={(count) => onChange({ ...override, count })}
      />

      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-muted-foreground">Motion</span>
        <RadioCardGroup
          value={override.motion}
          onChange={(motion) => onChange({ ...override, motion })}
          ariaLabel="Halo motion"
          layout="grid"
          columns={2}
          showDot={false}
          disabled={tuningDisabled}
          className="grid grid-cols-2 gap-1.5"
          options={HALO_MOTIONS.map((motion) => ({
            value: motion,
            label: HALO_MOTION_LABELS[motion],
          }))}
        />
      </div>

      <HaloTuningSliders override={override} disabled={tuningDisabled} onChange={onChange} />
      <div className="space-y-1.5">
        <ThemeTextureSlider
          label="Veil"
          value={`${Math.round(override.veil * 100)}%`}
          range={VEIL_RANGE}
          current={override.veil}
          disabled={disabled || !hasVeil}
          onChange={(veil) => onChange({ ...override, veil })}
        />
        <p className="text-xs text-muted-foreground">
          Less veil reveals stronger colors. 100% keeps the theme's original tint.
        </p>
      </div>
      <ThemeTextureSlider
        label="Grain"
        value={`${Math.round(grain * 100)}%`}
        range={GRAIN_OPACITY_RANGE}
        current={grain}
        disabled={disabled}
        onChange={(grainOpacity) => onChange({ ...override, grainOpacity })}
      />
      <HaloColorControls
        key={halos.length}
        theme={theme}
        halos={halos}
        override={override}
        disabled={tuningDisabled}
        onChange={onChange}
      />
    </div>
  );
}

function HaloSettingsError({
  error,
  canEdit,
  onRetry,
}: {
  error: string | null;
  canEdit: boolean;
  onRetry: () => void;
}): React.JSX.Element | null {
  if (error === null) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-destructive" role="alert">
        Could not read the saved tuning: {error}.{" "}
        {canEdit
          ? "Your next change replaces it."
          : "Changes are disabled until the saved tuning loads."}
      </p>
      {canEdit ? null : (
        <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

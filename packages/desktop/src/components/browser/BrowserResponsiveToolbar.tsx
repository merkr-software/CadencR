import { useUiTranslation } from "@/lib/i18n/ui";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactElement,
  type SetStateAction,
} from "react";
import { RotateCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  BrowserResponsiveColorScheme,
  BrowserResponsivePreset,
  BrowserResponsiveRequest,
  BrowserTabMetadata,
} from "@/lib/desktop-bridge";
import {
  isValidBrowserResponsiveState,
  toBrowserResponsiveRequest,
} from "@/shared/browser-responsive";

import { ResponsiveApplyActions, ResponsiveTouchToggle } from "./BrowserResponsiveActions";

interface BrowserResponsiveToolbarProps {
  tab: BrowserTabMetadata;
  pending: boolean;
  displayScale: number | null;
  onApply: (request: BrowserResponsiveRequest) => Promise<void>;
  onOverlayOpenChange: (open: boolean) => void;
}

const PRESETS: Record<Exclude<BrowserResponsivePreset, "custom">, BrowserResponsiveRequest> = {
  desktop: {
    enabled: true,
    preset: "desktop",
    width: 1_280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
    colorScheme: "system",
  },
  tablet: {
    enabled: true,
    preset: "tablet",
    width: 768,
    height: 1_024,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    colorScheme: "system",
  },
  mobile: {
    enabled: true,
    preset: "mobile",
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    colorScheme: "system",
  },
};

export const BrowserResponsiveToolbar = memo(function BrowserResponsiveToolbar({
  tab,
  pending,
  displayScale,
  onApply,
  onOverlayOpenChange,
}: BrowserResponsiveToolbarProps): ReactElement {
  const { t } = useUiTranslation();
  const responsive = tab.responsive;
  const [draft, setDraft] = useResponsiveDraft(tab);
  const [presetOpen, setPresetOpen] = useState(false);
  const [colorSchemeOpen, setColorSchemeOpen] = useState(false);
  useEffect(() => {
    onOverlayOpenChange(presetOpen || colorSchemeOpen);
    return () => onOverlayOpenChange(false);
  }, [colorSchemeOpen, onOverlayOpenChange, presetOpen]);
  const validDraft = useMemo(() => isValidBrowserResponsiveState(draft), [draft]);
  const validationError = validDraft
    ? null
    : t(
        "workspace.tools.browserResponsiveToolbar.invalidDraft",
        "Use 240–2560 px, DPR 1–3, and at most 4 MP.",
      );
  const updateNumber = useCallback(
    (field: "width" | "height" | "deviceScaleFactor", value: string): void => {
      setDraft((current) => ({ ...current, preset: "custom", [field]: Number(value) }));
    },
    [],
  );
  const choosePreset = useCallback((preset: BrowserResponsivePreset): void => {
    setDraft((current) =>
      preset === "custom"
        ? { ...current, preset }
        : { ...PRESETS[preset], colorScheme: current.colorScheme },
    );
  }, []);
  const rotate = useCallback((): void => {
    setDraft((current) => ({ ...current, width: current.height, height: current.width }));
  }, []);
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-1.5">
      <BrowserResponsiveViewportControls
        draft={draft}
        pending={pending}
        invalid={validationError !== null}
        choosePreset={choosePreset}
        updateNumber={updateNumber}
        rotate={rotate}
        onPresetOpenChange={setPresetOpen}
      />
      <ResponsiveTouchToggle
        enabled={draft.touch}
        pending={pending}
        onToggle={() => setDraft((current) => ({ ...current, touch: !current.touch }))}
      />
      <ColorSchemeSelect
        value={draft.colorScheme}
        disabled={pending}
        onOpenChange={setColorSchemeOpen}
        onChange={(colorScheme) => setDraft((current) => ({ ...current, colorScheme }))}
      />
      <div className="flex min-w-48 flex-1 items-center gap-2 overflow-hidden">
        <ResponsiveModeSummary enabled={responsive.enabled} displayScale={displayScale} />
        <span className="min-w-0 flex-1 truncate text-[10px] text-destructive" role="status">
          {responsive.status === "error"
            ? t(
                "workspace.tools.browserResponsiveToolbar.chromiumOverridesCouldNotBeFullyCleared",
                "Chromium overrides could not be fully cleared. Apply or exit to retry.",
              )
            : validationError}
        </span>
      </div>
      <ResponsiveApplyActions
        draft={draft}
        responsive={responsive}
        invalid={!validDraft}
        pending={pending}
        onApply={onApply}
      />
    </div>
  );
});

function useResponsiveDraft(
  tab: BrowserTabMetadata,
): [BrowserResponsiveRequest, Dispatch<SetStateAction<BrowserResponsiveRequest>>] {
  const responsive = tab.responsive;
  const [draft, setDraft] = useState<BrowserResponsiveRequest>(() =>
    toBrowserResponsiveRequest(responsive),
  );
  useEffect(() => {
    setDraft(toBrowserResponsiveRequest(responsive));
  }, [
    responsive.colorScheme,
    responsive.deviceScaleFactor,
    responsive.enabled,
    responsive.height,
    responsive.mobile,
    responsive.preset,
    responsive.status,
    responsive.touch,
    responsive.width,
    tab.id,
  ]);
  return [draft, setDraft];
}

function BrowserResponsiveViewportControls(props: {
  draft: BrowserResponsiveRequest;
  pending: boolean;
  invalid: boolean;
  choosePreset: (preset: BrowserResponsivePreset) => void;
  updateNumber: (field: "width" | "height" | "deviceScaleFactor", value: string) => void;
  rotate: () => void;
  onPresetOpenChange: (open: boolean) => void;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <>
      <Select
        value={props.draft.preset}
        disabled={props.pending}
        onOpenChange={props.onPresetOpenChange}
        onValueChange={(value) => props.choosePreset(value as BrowserResponsivePreset)}
      >
        <SelectTrigger
          size="sm"
          className="w-28"
          aria-label={t(
            "workspace.tools.browserResponsiveToolbar.responsiveDevicePreset",
            "Responsive device preset",
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="desktop">
            {t("workspace.tools.browserResponsiveToolbar.desktop", "Desktop")}
          </SelectItem>
          <SelectItem value="tablet">
            {t("workspace.tools.browserResponsiveToolbar.tablet", "Tablet")}
          </SelectItem>
          <SelectItem value="mobile">
            {t("workspace.tools.browserResponsiveToolbar.mobile", "Mobile")}
          </SelectItem>
          <SelectItem value="custom">
            {t("workspace.tools.browserResponsiveToolbar.custom", "Custom")}
          </SelectItem>
        </SelectContent>
      </Select>
      <DimensionInput
        label={t("workspace.tools.browserResponsiveToolbar.viewportWidth", "Viewport width")}
        shortLabel={t("workspace.tools.browserResponsiveToolbar.widthShort", "W")}
        value={props.draft.width}
        invalid={props.invalid}
        disabled={props.pending}
        onChange={(value) => props.updateNumber("width", value)}
      />
      <span aria-hidden="true" className="text-xs text-muted-foreground">
        ×
      </span>
      <DimensionInput
        label={t("workspace.tools.browserResponsiveToolbar.viewportHeight", "Viewport height")}
        shortLabel={t("workspace.tools.browserResponsiveToolbar.heightShort", "H")}
        value={props.draft.height}
        invalid={props.invalid}
        disabled={props.pending}
        onChange={(value) => props.updateNumber("height", value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={props.pending}
        onClick={props.rotate}
        aria-label={t(
          "workspace.tools.browserResponsiveToolbar.rotateResponsiveViewport",
          "Rotate responsive viewport",
        )}
        title={t("workspace.tools.browserResponsiveToolbar.rotateViewport", "Rotate viewport")}
      >
        <RotateCwIcon className="size-4" />
      </Button>
      <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {t("workspace.tools.browserResponsiveToolbar.dpr", "DPR")}
        <Input
          type="number"
          min={1}
          max={3}
          step={0.25}
          value={props.draft.deviceScaleFactor}
          disabled={props.pending}
          aria-label={t(
            "workspace.tools.browserResponsiveToolbar.devicePixelRatio",
            "Device pixel ratio",
          )}
          aria-invalid={props.invalid}
          className="h-8 w-16 px-2 font-mono text-xs"
          onChange={(event) => props.updateNumber("deviceScaleFactor", event.target.value)}
        />
      </label>
    </>
  );
}

function DimensionInput(props: {
  label: string;
  shortLabel: string;
  value: number;
  invalid: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
      {props.shortLabel}
      <Input
        type="number"
        min={240}
        max={2_560}
        step={1}
        value={props.value}
        disabled={props.disabled}
        aria-label={props.label}
        aria-invalid={props.invalid}
        className="h-8 w-20 px-2 font-mono text-xs"
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function ColorSchemeSelect(props: {
  value: BrowserResponsiveColorScheme;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: BrowserResponsiveColorScheme) => void;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onOpenChange={props.onOpenChange}
      onValueChange={(value) => props.onChange(value as BrowserResponsiveColorScheme)}
    >
      <SelectTrigger
        size="sm"
        className="w-24"
        aria-label={t(
          "workspace.tools.browserResponsiveToolbar.emulatedColorScheme",
          "Emulated color scheme",
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="system">
          {t("workspace.tools.browserResponsiveToolbar.system", "System")}
        </SelectItem>
        <SelectItem value="light">
          {t("workspace.tools.browserResponsiveToolbar.light", "Light")}
        </SelectItem>
        <SelectItem value="dark">
          {t("workspace.tools.browserResponsiveToolbar.dark", "Dark")}
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function ResponsiveModeSummary({
  enabled,
  displayScale,
}: {
  enabled: boolean;
  displayScale: number | null;
}): ReactElement {
  const { t } = useUiTranslation();
  const fit = enabled
    ? displayScale === null
      ? t("workspace.tools.browserResponsiveToolbar.fit", "Fit …")
      : t("workspace.tools.browserResponsiveToolbar.fitPercent", "Fit {{percent}}%", {
          percent: Math.round(displayScale * 100),
        })
    : t("workspace.tools.browserResponsiveToolbar.fitOff", "Fit off");
  return (
    <span
      className="min-w-0 truncate whitespace-nowrap text-[10px] text-muted-foreground"
      title={t(
        "workspace.tools.browserResponsiveToolbar.chromiumViewportEmulationThisDoesNotEmulate",
        "Chromium viewport emulation; this does not emulate Safari or change the mobile user agent.",
      )}
    >
      {fit}{" "}
      {t(
        "workspace.tools.browserResponsiveToolbar.chromiumMobileUaUnchanged",
        "· Chromium · mobile UA unchanged",
      )}
    </span>
  );
}

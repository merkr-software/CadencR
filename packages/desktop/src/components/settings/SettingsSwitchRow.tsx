import { useId, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { SettingsRow } from "./SettingsRow";
import { IconTile, type IconTileTint } from "./IconTile";

/**
 * Convenience wrapper around `SettingsRow` for the very common
 * "icon-tile + label + description + switch" pattern. Used by settings cards
 * such as editor preferences.
 */
export function SettingsSwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  saving = false,
  icon,
  iconTint = "muted",
  divided,
  className,
}: {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  /** A write is on its way: the switch keeps the confirmed state, locked, beside a spinner. */
  saving?: boolean;
  icon?: ReactNode;
  iconTint?: IconTileTint;
  divided?: boolean;
  className?: string;
}): React.JSX.Element {
  const fallbackId = useId();
  const switchId = id ?? fallbackId;

  return (
    <SettingsRow
      htmlFor={switchId}
      icon={icon ? <IconTile tint={iconTint}>{icon}</IconTile> : undefined}
      label={label}
      description={description}
      divided={divided}
      align="start"
      className={className}
      control={
        <span className="inline-flex items-center gap-2">
          {saving && <LoaderCircle aria-label="Saving" className="size-3.5 animate-spin" />}
          <Switch
            id={switchId}
            checked={checked}
            onCheckedChange={onCheckedChange}
            disabled={disabled || saving}
            aria-busy={saving}
          />
        </span>
      }
    />
  );
}

import { useId } from "react";
import { LoaderCircle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { NOTCH_PRIMARY_STYLE_KEY, useNotchPrefs } from "@/lib/notch/notch-prefs";
import { SettingsRow } from "./SettingsRow";

export function NotchPrimaryStyleSetting(): React.JSX.Element {
  const id = useId();
  const prefs = useNotchPrefs();
  const setting = useDebouncedSetting(NOTCH_PRIMARY_STYLE_KEY, 0, { immediateCache: false });
  const busy = setting.isLoading || setting.isSaving;
  const builtinOnly = prefs.displayMode === "builtin_always";

  return (
    <SettingsRow
      label="Primary display status"
      htmlFor={id}
      divided
      description={
        builtinOnly
          ? "Choose Both or Primary in Show notch on to customize the primary display status."
          : "On screens without a hardware notch, choose a thin activity strip or the built-in notch's full style. No status hides compact activity; notifications still appear. Hardware notches keep their own style."
      }
      control={
        <>
          {busy && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
          <Select
            value={prefs.primaryStyle}
            onValueChange={setting.setValue}
            disabled={busy || builtinOnly}
          >
            <SelectTrigger id={id} className="w-48" aria-busy={busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No status</SelectItem>
              <SelectItem value="strip_4">4 px</SelectItem>
              <SelectItem value="strip_8">8 px</SelectItem>
              <SelectItem value="builtin">Built-in notch style</SelectItem>
            </SelectContent>
          </Select>
        </>
      }
    />
  );
}

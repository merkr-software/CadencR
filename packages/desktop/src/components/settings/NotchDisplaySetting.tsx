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
import { NOTCH_DISPLAY_MODE_KEY, useNotchPrefs } from "@/lib/notch/notch-prefs";
import { SettingsRow } from "./SettingsRow";

export function NotchDisplaySetting(): React.JSX.Element {
  const id = useId();
  const prefs = useNotchPrefs();
  const setting = useDebouncedSetting(NOTCH_DISPLAY_MODE_KEY, 0, { immediateCache: false });
  const busy = setting.isLoading || setting.isSaving;

  return (
    <SettingsRow
      label="Show notch on"
      htmlFor={id}
      description="Built-in always uses your Mac's built-in display, or the primary display when it is disconnected. Both shows the same island on each. Primary follows your main display."
      control={
        <>
          {busy && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
          <Select value={prefs.displayMode} onValueChange={setting.setValue} disabled={busy}>
            <SelectTrigger id={id} className="w-40" aria-busy={busy}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="builtin_always">Built-in always</SelectItem>
              <SelectItem value="both">Both</SelectItem>
              <SelectItem value="primary">Primary</SelectItem>
            </SelectContent>
          </Select>
        </>
      }
    />
  );
}

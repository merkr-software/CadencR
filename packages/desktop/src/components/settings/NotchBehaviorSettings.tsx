import { LoaderCircle } from "lucide-react";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import {
  NOTCH_ALWAYS_ANIMATE_KEY,
  NOTCH_ALWAYS_ON_KEY,
  useNotchPrefs,
} from "@/lib/notch/notch-prefs";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

/** How the notch island behaves; rendered by `NotchSettings` while the notch is the destination. */
export function NotchBehaviorSettings(): React.JSX.Element {
  const prefs = useNotchPrefs();
  const alwaysOn = useDebouncedSetting(NOTCH_ALWAYS_ON_KEY, 0, { immediateCache: false });
  const alwaysAnimate = useDebouncedSetting(NOTCH_ALWAYS_ANIMATE_KEY, 0, { immediateCache: false });

  return (
    <>
      <SettingsSwitchRow
        label={
          <SavingLabel saving={alwaysOn.isLoading || alwaysOn.isSaving}>Always on</SavingLabel>
        }
        description="Show compact activity while agents work, wait for you, or have unread replies. Off, it appears only on hover or for notifications. No status always hides compact activity on the primary display."
        checked={prefs.alwaysOn}
        onCheckedChange={(next) => alwaysOn.setValue(String(next))}
        disabled={alwaysOn.isLoading || alwaysOn.isSaving}
        divided
      />
      <SettingsSwitchRow
        label={
          <SavingLabel saving={alwaysAnimate.isLoading || alwaysAnimate.isSaving}>
            Always animate
          </SavingLabel>
        }
        description="Animate the logo and working indicators even with the island closed. Waiting and finished session dots stay still. Off, animations run only once the island opens."
        checked={prefs.alwaysAnimate}
        onCheckedChange={(next) => alwaysAnimate.setValue(String(next))}
        disabled={alwaysAnimate.isLoading || alwaysAnimate.isSaving}
        divided
      />
    </>
  );
}

function SavingLabel({ saving, children }: { saving: boolean; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {children}
      {saving ? <LoaderCircle aria-label="Saving" className="size-3.5 animate-spin" /> : null}
    </span>
  );
}

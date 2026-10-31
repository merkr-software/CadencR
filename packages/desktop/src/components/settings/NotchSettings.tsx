import { useState } from "react";
import { toast } from "sonner";
import { useNotchDestinationActive } from "@/components/notch/useNotchCapabilities";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { NotchBehaviorSettings } from "./NotchBehaviorSettings";
import { NotchDisplaySetting } from "./NotchDisplaySetting";
import { NotchPrimaryStyleSetting } from "./NotchPrimaryStyleSetting";
import { SettingsRow } from "./SettingsRow";
import { SettingsGroup } from "./SettingsGroup";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

/**
 * Notch-only settings: the island's behavior switches, then a button that
 * peeks a sample notification out of it so the result can be judged live.
 */
export function NotchSettings(): React.JSX.Element | null {
  const active = useNotchDestinationActive();
  const [sending, setSending] = useState(false);
  if (!active) return null;

  const handlePreview = async () => {
    setSending(true);
    try {
      await desktopBridge.notchNotify({
        id: `preview-${Date.now()}`,
        featureId: null,
        projectId: null,
        status: "completed",
        title: "Your agent finished",
        body: "This is how a finished agent peeks out of the notch. Hover the notch anytime to see every running agent and jump straight into its conversation.",
      });
    } catch (e: unknown) {
      toast.error("Couldn't preview the notch island", {
        description: apiErrorMessage(e, String(e)),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <SettingsGroup
      id={SETTINGS_ANCHORS.notch}
      title="Notch island"
      description="Agent activity and notifications around the MacBook camera notch."
    >
      <NotchDisplaySetting />
      <NotchPrimaryStyleSetting />
      <NotchBehaviorSettings />
      <SettingsRow
        divided
        label="Preview the notch island"
        description="Peeks a sample notification out of the notch. Hover the notch to see the live agent list."
        control={
          <Button variant="outline" size="sm" onClick={handlePreview} disabled={sending}>
            {sending ? "Sending…" : "Preview"}
          </Button>
        }
      />
    </SettingsGroup>
  );
}

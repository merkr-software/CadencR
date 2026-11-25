import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
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
  const { t } = useUiTranslation();
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
        title: null,
        body: "",
      });
    } catch (e: unknown) {
      toast.error(
        translateUi(
          "settings.notifications.notch.previewError",
          "Couldn't preview the notch island",
        ),
        {
          description: apiErrorMessage(e, String(e)),
        },
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <SettingsGroup
      id={SETTINGS_ANCHORS.notch}
      title={t("settings.notifications.notch.sectionTitle", "Notch island")}
      description={t(
        "settings.notifications.notch.sectionDescription",
        "Agent activity and notifications around the MacBook camera notch.",
      )}
    >
      <NotchDisplaySetting />
      <NotchPrimaryStyleSetting />
      <NotchBehaviorSettings />
      <SettingsRow
        divided
        label={t("settings.notifications.notch.previewLabel", "Preview the notch island")}
        description={t(
          "settings.notifications.notch.previewDescription",
          "Peeks a sample notification out of the notch. Hover the notch to see the live agent list.",
        )}
        control={
          <Button variant="outline" size="sm" onClick={handlePreview} disabled={sending}>
            {sending
              ? t("common.sending", "Sending…")
              : t("settings.notifications.notch.previewAction", "Preview")}
          </Button>
        }
      />
    </SettingsGroup>
  );
}

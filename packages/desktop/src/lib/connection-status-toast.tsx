import { toast } from "sonner";
import { formatConnectionReason, type ConnectionReason } from "@/lib/connection-reason";
import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { AUTO_RECONNECT_TIMEOUT_SECONDS } from "@/lib/ws-reconnect";

const MANUAL_RECONNECT_TOAST_ID = "backend-manual-reconnect-required";

function ReconnectPausedDetail({ reason }: { reason: ConnectionReason | null }) {
  const { t, i18n } = useUiTranslation();
  const locale = formattingLocale(i18n.language);
  return t(
    "conversation.connection.pausedDetail",
    "{{reason}} Automatic retries are paused after {{count, number}} seconds.",
    {
      reason: reason
        ? formatConnectionReason(reason, t, locale)
        : t("conversation.connection.failed", "Cadencr could not reconnect to the local backend."),
      count: AUTO_RECONNECT_TIMEOUT_SECONDS,
      defaultValue_one: "{{reason}} Automatic retries are paused after {{count, number}} second.",
      formatParams: { count: { locale } },
    },
  );
}

export function showReconnectPausedToast(reason: ConnectionReason | null, retry: () => void): void {
  toast.error(
    <UiTrans i18nKey="conversation.connection.paused" defaults="Backend reconnect paused" />,
    {
      id: MANUAL_RECONNECT_TOAST_ID,
      description: <ReconnectPausedDetail reason={reason} />,
      duration: Infinity,
      action: {
        label: <UiTrans i18nKey="conversation.connection.retryNow" defaults="Retry now" />,
        onClick: retry,
      },
    },
  );
}

export function dismissReconnectPausedToast(): void {
  toast.dismiss(MANUAL_RECONNECT_TOAST_ID);
}

export function showBackendReconnectedToast(): void {
  toast.success(
    <UiTrans i18nKey="conversation.connection.restored" defaults="Reconnected to backend" />,
    { id: "backend-reconnected", duration: 3000 },
  );
}

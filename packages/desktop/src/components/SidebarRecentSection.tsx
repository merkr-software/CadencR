import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { HistoryIcon } from "lucide-react";
import { useListRecentFeatures, type Feature } from "@/api/generated";
import { SidebarConversationBlock } from "@/components/SidebarConversationBlock";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { apiErrorMessage } from "@/lib/api-errors";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useSidebarFilterQuery } from "@/stores/sidebar-filter-store";

interface SectionProps {
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}

/** The largest "Recent shows" choice: one cached list, sliced to the chosen count. */
const RECENT_FETCH_LIMIT = 10;
const NO_FEATURES: Feature[] = [];

/**
 * "Recent" (F4): the last few conversations touched (latest message sent, else
 * created), across all projects, newest first. Off by default.
 */
export function SidebarRecentSection(props: SectionProps): ReactElement | null {
  return useSidebarOption("recentBlock") ? <RecentBlock {...props} /> : null;
}

function RecentBlock({ activeFeatureId, onSelectFeature }: SectionProps): ReactElement | null {
  const { t } = useUiTranslation();
  const count = Number(useSidebarOption("recentCount"));
  const filtering = useSidebarFilterQuery() !== "";
  const query = useRecentFeatures(!filtering);
  const recent = query.data ?? NO_FEATURES;
  const features = useMemo(() => recent.slice(0, count), [recent, count]);
  return (
    <SidebarConversationBlock
      label={t("sidebar.recentSection.recent", "Recent")}
      icon={HistoryIcon}
      surface="recent"
      features={features}
      loading={query.isPending}
      error={
        query.error
          ? apiErrorMessage(
              query.error,
              translateUi(
                "sidebar.recentSection.couldNotLoadRecentConversations",
                "Could not load recent conversations",
              ),
            )
          : undefined
      }
      empty={t("sidebar.recentSection.noConversationYet", "No conversation yet")}
      activeFeatureId={activeFeatureId}
      onSelectFeature={onSelectFeature}
    />
  );
}

/**
 * The conversations touched last, newest first (one cached list for every
 * surface that shows them: the sidebar's Recent, the phone inbox), refetched
 * when a turn starts.
 */
export function useRecentFeatures(enabled: boolean) {
  const query = useListRecentFeatures({ limit: RECENT_FETCH_LIMIT }, { query: { enabled } });
  useRefetchOnNewTurn(query.refetch, enabled);
  return query;
}

/**
 * A turn starting means a message was just sent: that conversation is now the
 * most recent one. Feature-list invalidations cover renames, archives and new
 * conversations, but nothing else reports a sent message.
 */
function useRefetchOnNewTurn(
  refetch: (options: { cancelRefetch: boolean }) => unknown,
  enabled: boolean,
): void {
  const { entries } = useSidebarAttention();
  const workingKey = useMemo(
    () =>
      entries
        .filter((entry) => entry.state === "working")
        .map((entry) => entry.featureId)
        .join(","),
    [entries],
  );
  const previous = useRef(workingKey);
  useEffect(() => {
    const before = new Set(previous.current.split(","));
    previous.current = workingKey;
    const started = workingKey !== "" && workingKey.split(",").some((id) => !before.has(id));
    // Each surface showing the list refetches it: the first starts the
    // request, the others join it instead of cancelling it for one of theirs.
    if (enabled && started) void refetch({ cancelRefetch: false });
  }, [enabled, refetch, workingKey]);
}

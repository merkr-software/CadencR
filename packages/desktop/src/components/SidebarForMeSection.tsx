import { useMemo, useState, type ReactElement } from "react";
import { InboxIcon } from "lucide-react";
import { SidebarConversationBlock } from "@/components/SidebarConversationBlock";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { SidebarShowMoreButton } from "@/components/SidebarShowMore";
import { useForMeShowMore } from "@/hooks/useForMeShowMore";
import { useFrozenActionOrder } from "@/hooks/useFrozenActionOrder";
import { isStrongAction, type ResolvedNextAction } from "@/lib/next-actions";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";
import { useSidebarOption } from "@/stores/sidebar-config-store";

interface SectionProps {
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}

/**
 * "For me" (F2): the user's next actions across all projects, one row per
 * conversation, most urgent first: answer a pending request, look at a failed
 * turn, fix a pull request's checks or address its review, review a finished
 * reply, merge an approved pull request. Each row names its action under its
 * title. The first 3 or 5 show (the "For me shows" option), the rest behind
 * "Show more".
 * Agents at work stay out: nothing to do there yet.
 */
export function SidebarForMeSection(props: SectionProps): ReactElement | null {
  return useSidebarOption("forMe") ? <ForMeBlock {...props} /> : null;
}

function ForMeBlock({ activeFeatureId, onSelectFeature }: SectionProps): ReactElement | null {
  const { actions: liveActions, actionsLoading } = useSidebarAttention();
  // Rows hold their place while the pointer is on the list or the user works a quick
  // reply (clicked or hovered open): not for an automatic card, which nobody is using.
  const [pointerOver, setPointerOver] = useState(false);
  const gateInUse = usePendingGatePopoverStore(
    (state) => state.open?.origin === "user" || state.open?.origin === "hover",
  );
  const actions = useFrozenActionOrder(liveActions, pointerOver || gateInUse);
  const more = useForMeShowMore(actions.length);
  const { features, kinds } = useMemo(
    () => visibleActions(actions, more.visibleCount),
    [actions, more.visibleCount],
  );
  const strongCount = useMemo(() => actions.filter(isStrongAction).length, [actions]);
  return (
    <div
      className="contents"
      onPointerEnter={() => setPointerOver(true)}
      onPointerLeave={() => setPointerOver(false)}
    >
      <SidebarConversationBlock
        label="For me"
        icon={InboxIcon}
        surface="for-me"
        features={features}
        count={actions.length}
        nextActions={kinds}
        footer={<SidebarShowMoreButton more={more} />}
        loading={actionsLoading}
        empty="Nothing waiting on you"
        strongCount={strongCount}
        activeFeatureId={activeFeatureId}
        onSelectFeature={onSelectFeature}
      />
    </div>
  );
}

function visibleActions(actions: readonly ResolvedNextAction[], count: number) {
  const shown = actions.slice(0, count);
  return {
    features: shown.map((action) => action.feature),
    kinds: new Map(shown.map((action) => [action.feature.id, action.kind])),
  };
}

import { memo, type ReactElement } from "react";
import type { Feature } from "@/api/generated";
import { InboxCard } from "@/components/phone-inbox/PhoneInboxCard";
import {
  actionView,
  useWaitingActionView,
  type NextActionView,
} from "@/components/SidebarNextActionLine";
import type { NextActionKind } from "@/lib/next-actions";
import { selectPrStatus, usePrStatusStore } from "@/stores/usePrStatusStore";

interface ForMeCardProps {
  feature: Feature;
  kind: NextActionKind;
  projectName: string | undefined;
  onOpen: (feature: Feature) => void;
  /** Opens the phone quick reply (the bottom sheet) on the conversation's request. */
  onQuickReply: (featureId: number) => void;
}

/**
 * A For me entry: what is asked under the title (the sidebar's request or pull
 * request text), and the verb as the card's action. A pending permission or
 * question is answered in the quick reply sheet, without leaving the inbox;
 * any other action (a plan, a reply to review, an error, a pull request) is
 * done in the conversation. Only a waiting card fetches its request.
 */
export const ForMeCard = memo(function ForMeCard({ kind, ...props }: ForMeCardProps): ReactElement {
  return kind === "waiting" ? <WaitingCard {...props} /> : <PlainCard {...props} kind={kind} />;
});

type CardProps = Omit<ForMeCardProps, "kind">;

function WaitingCard(props: CardProps): ReactElement {
  return <ForMeCardView {...props} view={useWaitingActionView(props.feature.id)} />;
}

function PlainCard({
  kind,
  ...props
}: CardProps & { kind: Exclude<NextActionKind, "waiting"> }): ReactElement {
  const prStatus = usePrStatusStore(selectPrStatus(props.feature.id));
  return <ForMeCardView {...props} view={actionView(kind, prStatus)} />;
}

function ForMeCardView({
  feature,
  projectName,
  onOpen,
  onQuickReply,
  view,
}: CardProps & { view: NextActionView }): ReactElement {
  const summary = (
    <span
      data-phone-inbox-summary
      className="min-w-0 truncate text-[13px] leading-[18px] text-muted-foreground"
    >
      {view.object ?? view.detail}
    </span>
  );
  return (
    <InboxCard
      feature={feature}
      projectName={projectName}
      summary={summary}
      action={{
        label: view.label,
        className: view.className,
        onPress: () => (view.quickReply ? onQuickReply(feature.id) : onOpen(feature)),
      }}
      onOpen={onOpen}
    />
  );
}

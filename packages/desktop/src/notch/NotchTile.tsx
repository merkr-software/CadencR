import { memo, type CSSProperties } from "react";
import {
  BotIcon,
  CheckIcon,
  FileTextIcon,
  GlobeIcon,
  MessageCircleQuestionIcon,
  PencilIcon,
  PlugIcon,
  SearchIcon,
  ShieldAlertIcon,
  TerminalIcon,
  WorkflowIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import type { NotchActionKind, NotchAgent } from "@/shared/notch";

const ACTION_ICONS: Record<NotchActionKind, LucideIcon> = {
  bash: TerminalIcon,
  edit: PencilIcon,
  read: FileTextIcon,
  search: SearchIcon,
  web: GlobeIcon,
  agent: WorkflowIcon,
  mcp: PlugIcon,
  tool: WrenchIcon,
};

export function ActionIcon({ kind }: { kind: NotchActionKind }): React.JSX.Element {
  const Icon = ACTION_ICONS[kind];
  return <Icon aria-hidden="true" strokeWidth={2} />;
}

type TileAgent = Pick<
  NotchAgent,
  "status" | "pendingKind" | "providerIconSrc" | "providerIconMono" | "providerLabel" | "unread"
>;

function StatusBadge({ agent }: { agent: TileAgent }): React.JSX.Element | null {
  if (agent.status === "running") return <span className="badge-spin" />;
  if (agent.status === "question") {
    return agent.pendingKind === "permission" ? (
      <ShieldAlertIcon
        className="tone-permission"
        strokeWidth={2.6}
        aria-label="Needs permission"
      />
    ) : (
      <MessageCircleQuestionIcon
        className="tone-question"
        strokeWidth={2.6}
        aria-label="Asked a question"
      />
    );
  }
  if (agent.unread)
    return <CheckIcon className="tone-done" strokeWidth={3.4} aria-label="Unread" />;
  return null;
}

/** Provider silhouette on a raised tile, with the agent's live status as a corner badge. */
export const NotchTile = memo(function NotchTile({
  agent,
  size = "md",
}: {
  agent: TileAgent;
  size?: "md" | "lg";
}): React.JSX.Element {
  const src = agent.providerIconSrc;
  return (
    <span className="tile" data-size={size} title={agent.providerLabel ?? undefined}>
      {src && agent.providerIconMono ? (
        <span className="tile-mark" style={{ "--mark": `url("${src}")` } as CSSProperties} />
      ) : src ? (
        <img className="tile-img" src={src} alt="" />
      ) : (
        <BotIcon className="tile-img" strokeWidth={1.8} aria-hidden="true" />
      )}
      {hasBadge(agent) ? (
        <span className="tile-badge">
          <StatusBadge agent={agent} />
        </span>
      ) : null}
    </span>
  );
});

function hasBadge(agent: TileAgent): boolean {
  return agent.status !== "done" || agent.unread;
}

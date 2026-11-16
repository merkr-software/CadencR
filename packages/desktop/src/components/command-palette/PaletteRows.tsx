import { memo, type ReactElement } from "react";
import {
  ArchiveIcon,
  BotIcon,
  MessageCircleQuestionIcon,
  PinIcon,
  ShieldAlertIcon,
  UserIcon,
} from "lucide-react";
import { Command as CommandPrimitive } from "cmdk";
import { ProjectBadge } from "@/components/ProjectBadge";
import { nextActionVerb } from "@/components/SidebarNextActionLine";
import { StatusShape } from "@/components/StatusShape";
import { PENDING_KIND_TEXT_CLASS, triggerPendingKind } from "@/components/sidebar-pending-gate";
import { FileSymbolIcon } from "@/components/editor/file-icons";
import { parseUTCDateTime } from "@/lib/date-utils";
import type { NextActionKind } from "@/lib/next-actions";
import type {
  CommandEntry,
  ConversationEntry,
  FileEntry,
  MessageEntry,
  PaletteEntry,
  ProjectEntry,
} from "@/lib/command-palette/palette-types";
import type { AttentionState } from "@/lib/sidebar-attention";
import { formatSidebarRelativeTime } from "@/lib/sidebar-time";
import { cn } from "@/lib/utils";
import { useFeatureStatus } from "@/stores/session-status-selectors";
import type { PendingKind } from "@/types/agent";
import { HighlightedText, PaletteKeys, positionsToRanges, SnippetText } from "./PaletteText";

function relativeTime(value: string, now: number): string {
  const date = parseUTCDateTime(value);
  return Number.isNaN(date.getTime()) ? "" : formatSidebarRelativeTime(date, now);
}

/** What a waiting conversation asks, from its live status (no request lookup). */
function usePendingKind(featureId: number): PendingKind {
  return triggerPendingKind(useFeatureStatus(featureId).kind, null);
}

/** The sidebar's status shapes; a pending request is its shield or question mark (answered once opened). */
export function ConversationStatus({
  featureId,
  state,
  archived,
}: {
  featureId: number;
  state: AttentionState;
  archived: boolean;
}): ReactElement {
  if (archived && state === "idle") {
    return <ArchiveIcon aria-label="Archived" className="size-3 text-muted-foreground" />;
  }
  if (state === "waiting") return <WaitingGlyph featureId={featureId} />;
  return <StatusShape state={state} />;
}

function WaitingGlyph({ featureId }: { featureId: number }): ReactElement {
  const kind = usePendingKind(featureId);
  const className = cn("size-3.5", PENDING_KIND_TEXT_CLASS[kind]);
  return kind === "question" ? (
    <MessageCircleQuestionIcon aria-label="Asks a question" className={className} />
  ) : (
    <ShieldAlertIcon aria-label="Asks for permission" className={className} />
  );
}

function NextActionVerb({
  featureId,
  kind,
}: {
  featureId: number;
  kind: NextActionKind;
}): ReactElement {
  const verb = nextActionVerb(kind, usePendingKind(featureId));
  return <span className={cn("cp-verb", verb.className)}>{verb.label}</span>;
}

function ConversationRow({
  entry,
  projectName,
  now,
}: {
  entry: ConversationEntry;
  projectName: string | undefined;
  now: number;
}): ReactElement {
  const { conversation } = entry;
  const archived = conversation.status === "archived";
  return (
    <>
      <span className="cp-row-status">
        <ConversationStatus
          featureId={conversation.id}
          state={entry.attention}
          archived={archived}
        />
      </span>
      <span className="cp-row-title">
        <HighlightedText text={conversation.title} ranges={entry.ranges} />
      </span>
      {conversation.is_pinned && !archived && (
        <PinIcon aria-label="Pinned" className="!size-3 text-muted-foreground" />
      )}
      {conversation.label && <span className="cp-label">{conversation.label}</span>}
      <span className="cp-row-meta">
        <ProjectBadge projectId={conversation.project_id} size="xs" />
        <span className="cp-row-meta-text">{projectName}</span>
      </span>
      {entry.nextAction ? (
        <NextActionVerb featureId={conversation.id} kind={entry.nextAction} />
      ) : (
        <span className="cp-row-time">{relativeTime(conversation.last_activity_at, now)}</span>
      )}
    </>
  );
}

function CommandRow({ entry }: { entry: CommandEntry }): ReactElement {
  const { command } = entry;
  return (
    <>
      <span className="cp-row-icon">{command.icon}</span>
      <span className="cp-row-title">
        <HighlightedText text={command.title} ranges={entry.ranges} />
      </span>
      {command.shortcutId && <PaletteKeys id={command.shortcutId} />}
    </>
  );
}

function FileRow({ entry }: { entry: FileEntry }): ReactElement {
  const slash = entry.path.lastIndexOf("/");
  const name = entry.path.slice(slash + 1);
  const directory = slash > 0 ? entry.path.slice(0, slash) : "";
  return (
    <>
      <span className="cp-row-icon">
        <FileSymbolIcon fileName={name} className="flex items-center" />
      </span>
      <span className="cp-row-title">
        <HighlightedText text={name} ranges={positionsToRanges(entry.positions, slash + 1)} />
      </span>
      {directory && (
        <span className="cp-row-meta">
          <span className="cp-row-meta-text cp-path">{directory}</span>
        </span>
      )}
    </>
  );
}

function MessageRow({ entry, now }: { entry: MessageEntry; now: number }): ReactElement {
  const { hit } = entry;
  return (
    <>
      <span className="cp-row-icon">
        {hit.role === "user" ? <UserIcon aria-label="You" /> : <BotIcon aria-label="Agent" />}
      </span>
      <span className="cp-row-title">
        <SnippetText snippet={hit.snippet} />
      </span>
      <span className="cp-row-meta">
        <ProjectBadge projectId={hit.project_id} size="xs" />
        <span className="cp-row-meta-text">{hit.feature_title}</span>
      </span>
      <span className="cp-row-time">{relativeTime(hit.created_at, now)}</span>
    </>
  );
}

function ProjectRow({ entry }: { entry: ProjectEntry }): ReactElement {
  return (
    <>
      <span className="cp-row-icon">
        <ProjectBadge projectId={entry.project.id} size="sm" />
      </span>
      <span className="cp-row-title">
        <HighlightedText text={entry.project.name} ranges={entry.ranges} />
      </span>
      <span className="cp-row-meta">
        <span className="cp-row-meta-text">
          {entry.activeCount} active
          {entry.archivedCount > 0 && ` · ${entry.archivedCount} archived`}
        </span>
      </span>
    </>
  );
}

interface PaletteRowProps {
  entry: PaletteEntry;
  projectName: string | undefined;
  now: number;
  onPick: (entry: PaletteEntry) => void;
}

/** One result: a cmdk item keyed by the entry, so arrows, Enter and hover work as one. */
export const PaletteRow = memo(function PaletteRow({
  entry,
  projectName,
  now,
  onPick,
}: PaletteRowProps): ReactElement {
  const archived = entry.kind === "conversation" && entry.conversation.status === "archived";
  return (
    <CommandPrimitive.Item
      value={entry.key}
      onSelect={() => onPick(entry)}
      data-archived={archived || undefined}
      className="cp-row"
    >
      {entry.kind === "conversation" && (
        <ConversationRow entry={entry} projectName={projectName} now={now} />
      )}
      {entry.kind === "command" && <CommandRow entry={entry} />}
      {entry.kind === "file" && <FileRow entry={entry} />}
      {entry.kind === "message" && <MessageRow entry={entry} now={now} />}
      {entry.kind === "project" && <ProjectRow entry={entry} />}
    </CommandPrimitive.Item>
  );
});

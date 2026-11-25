import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { memo, type ReactElement, type ReactNode } from "react";
import { UserIcon } from "lucide-react";
import { AgentIcon } from "@/components/AgentIcon";
import { useGetFeatureRowSummary, useReadFile } from "@/api/generated";
import { ProjectBadge } from "@/components/ProjectBadge";
import { SidebarNextActionLine } from "@/components/SidebarNextActionLine";
import { SidebarPendingRequestLine } from "@/components/SidebarPendingRequestLine";
import { Skeleton } from "@/components/ui/skeleton";
import { FileSymbolIcon } from "@/components/editor/file-icons";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { apiErrorMessage } from "@/lib/api-errors";
import { parseUTCDateTime } from "@/lib/date-utils";
import { getFileName } from "@/lib/file-language";
import type {
  CommandEntry,
  ConversationEntry,
  FileEntry,
  MessageEntry,
  PaletteEntry,
  ProjectEntry,
} from "@/lib/command-palette/palette-types";
import { ATTENTION_LABEL } from "@/lib/sidebar-attention";
import { paletteCommandGroupLabel } from "@/lib/command-palette/palette-shortcut-commands";
import { formatSidebarFullTime, formatSidebarRelativeTime } from "@/lib/sidebar-time";
import { usePrStatusStore } from "@/stores/usePrStatusStore";
import { ConversationStatus } from "./PaletteRows";
import { PaletteKeys, SnippetText } from "./PaletteText";
import { PaletteProviderMark } from "./PaletteProviderMark";

function when(value: string, now: number, t: UiTranslator): string {
  const date = parseUTCDateTime(value);
  if (Number.isNaN(date.getTime())) return value;
  return t("palette.preview.timestamp", "{{absolute}} · {{relative}}", {
    absolute: formatSidebarFullTime(date),
    relative: formatSidebarRelativeTime(date, now),
  });
}

function Fact({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <section className="cp-preview-block">
      <h3 className="cp-preview-block-label">{label}</h3>
      {children}
    </section>
  );
}

/**
 * Previews fetch once the selection rests, so arrowing through a list doesn't
 * send a request per row; what is cached shows at once.
 */
const PREVIEW_FETCH_DELAY_MS = 120;

function useSettled<T>(value: T): boolean {
  return useDebouncedValue(value, PREVIEW_FETCH_DELAY_MS) === value;
}

function LastReply({ featureId }: { featureId: number }): ReactElement {
  const { t } = useUiTranslation();
  const settled = useSettled(featureId);
  const summary = useGetFeatureRowSummary(featureId, {
    query: { enabled: settled, staleTime: 5 * 60_000, retry: false, refetchOnWindowFocus: false },
  });
  if (summary.isPending) {
    return (
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  }
  if (summary.error) {
    return (
      <p className="text-(--acc-red) text-xs">
        {apiErrorMessage(
          summary.error,
          t("palette.preview.errors.reply", "Couldn't load the last reply"),
        )}
      </p>
    );
  }
  const preview = summary.data?.preview?.trim();
  return preview ? (
    <p className="cp-preview-text">{preview}</p>
  ) : (
    <p className="cp-preview-sub">{t("palette.preview.noReply", "No reply yet.")}</p>
  );
}

function ConversationPreview({
  entry,
  projectName,
  now,
}: {
  entry: ConversationEntry;
  projectName: string | undefined;
  now: number;
}): ReactElement {
  const { t } = useUiTranslation();
  const { conversation } = entry;
  const archived = conversation.status === "archived";
  const prStatus = usePrStatusStore((state) => state.byFeature[conversation.id]);
  const state =
    archived && entry.attention === "idle"
      ? t("palette.status.archived", "Archived")
      : ATTENTION_LABEL[entry.attention];
  return (
    <div className="cp-preview-inner">
      <header className="cp-preview-head">
        <span className="cp-preview-glyph">
          <ConversationStatus
            featureId={conversation.id}
            state={entry.attention}
            archived={archived}
          />
        </span>
        <div className="min-w-0">
          <h2 className="cp-preview-title">{conversation.title}</h2>
          <p className="cp-preview-sub">{state}</p>
        </div>
      </header>
      {entry.nextAction && (
        <SidebarNextActionLine
          kind={entry.nextAction}
          featureId={conversation.id}
          prStatus={prStatus}
        />
      )}
      <SidebarPendingRequestLine
        attention={{ state: entry.attention, sourceFeatureId: conversation.id }}
      />
      <dl className="cp-facts">
        <Fact label={t("palette.preview.project", "Project")}>
          <ProjectBadge projectId={conversation.project_id} size="xs" />
          <span>{projectName ?? t("palette.preview.unknownProject", "Unknown project")}</span>
        </Fact>
        {conversation.worktree_branch && (
          <Fact label={t("palette.preview.branch", "Branch")}>
            <span className="cp-path">{conversation.worktree_branch}</span>
          </Fact>
        )}
        {conversation.runtime_provider && (
          <Fact label={t("palette.preview.agent", "Agent")}>
            <PaletteProviderMark providerId={conversation.runtime_provider} />
          </Fact>
        )}
        {conversation.label && (
          <Fact label={t("palette.preview.label", "Label")}>
            <span className="cp-label">{conversation.label}</span>
          </Fact>
        )}
        <Fact label={t("palette.preview.active", "Active")}>
          <span>{when(conversation.last_activity_at, now, t)}</span>
        </Fact>
        {conversation.archived_at && (
          <Fact label={t("palette.status.archived", "Archived")}>
            <span>{when(conversation.archived_at, now, t)}</span>
          </Fact>
        )}
      </dl>
      <Block label={t("palette.preview.lastReply", "Last reply")}>
        <LastReply featureId={conversation.id} />
      </Block>
    </div>
  );
}

function CommandPreview({ entry }: { entry: CommandEntry }): ReactElement {
  const { t } = useUiTranslation();
  const { command } = entry;
  return (
    <div className="cp-preview-inner">
      <header className="cp-preview-head">
        <span className="cp-preview-glyph">{command.icon}</span>
        <div className="min-w-0">
          <h2 className="cp-preview-title">{command.title}</h2>
          <p className="cp-preview-sub">{paletteCommandGroupLabel(command.group, t)}</p>
        </div>
      </header>
      {command.description && <p className="cp-preview-text">{command.description}</p>}
      {command.shortcutId && (
        <dl className="cp-facts">
          <Fact label={t("palette.preview.shortcut", "Shortcut")}>
            <PaletteKeys id={command.shortcutId} />
          </Fact>
        </dl>
      )}
    </div>
  );
}

const FILE_PREVIEW_LINES = 40;

function FilePreview({
  entry,
  projectId,
  featureId,
}: {
  entry: FileEntry;
  projectId: number | null;
  featureId: number | null;
}): ReactElement {
  const { t } = useUiTranslation();
  const settled = useSettled(entry.path);
  const file = useReadFile(
    { project_id: projectId ?? 0, feature_id: featureId, file_path: entry.path },
    { query: { enabled: settled && projectId != null, staleTime: 30_000, retry: false } },
  );
  const name = getFileName(entry.path);
  return (
    <div className="cp-preview-inner">
      <header className="cp-preview-head">
        <span className="cp-preview-glyph">
          <FileSymbolIcon fileName={name} className="flex items-center" />
        </span>
        <div className="min-w-0">
          <h2 className="cp-preview-title">{name}</h2>
          <p className="cp-preview-sub cp-path break-all">{entry.path}</p>
        </div>
      </header>
      {file.isPending && <Skeleton className="h-40 w-full" />}
      {file.error && (
        <p className="text-(--acc-red) text-xs">
          {apiErrorMessage(file.error, t("palette.preview.errors.file", "Couldn't read the file"))}
        </p>
      )}
      {file.data && (
        <pre className="cp-code">
          {file.data.large
            ? t("palette.preview.largeFile", "Large file: open it to read.")
            : file.data.content.split("\n").slice(0, FILE_PREVIEW_LINES).join("\n")}
        </pre>
      )}
    </div>
  );
}

function messageRoleLabel(hit: MessageEntry["hit"], t: UiTranslator): string {
  if (hit.role === "user") {
    return hit.feature_status === "archived"
      ? t("palette.preview.archivedPrompt", "Your prompt · archived conversation")
      : t("palette.preview.prompt", "Your prompt");
  }
  return hit.feature_status === "archived"
    ? t("palette.preview.archivedReply", "Agent reply · archived conversation")
    : t("palette.preview.reply", "Agent reply");
}

function MessagePreview({
  entry,
  projectName,
  now,
}: {
  entry: MessageEntry;
  projectName: string | undefined;
  now: number;
}): ReactElement {
  const { t } = useUiTranslation();
  const { hit } = entry;
  return (
    <div className="cp-preview-inner">
      <header className="cp-preview-head">
        <span className="cp-preview-glyph">
          {hit.role === "user" ? <UserIcon /> : <AgentIcon />}
        </span>
        <div className="min-w-0">
          <h2 className="cp-preview-title">{hit.feature_title}</h2>
          <p className="cp-preview-sub">{messageRoleLabel(hit, t)}</p>
        </div>
      </header>
      <p className="cp-preview-text">
        <SnippetText snippet={hit.snippet} />
      </p>
      <dl className="cp-facts">
        <Fact label={t("palette.preview.project", "Project")}>
          <ProjectBadge projectId={hit.project_id} size="xs" />
          <span>{projectName ?? t("palette.preview.unknownProject", "Unknown project")}</span>
        </Fact>
        <Fact label={t("palette.preview.sent", "Sent")}>
          <span>{when(hit.created_at, now, t)}</span>
        </Fact>
      </dl>
      <p className="cp-preview-sub">
        {t(
          "palette.preview.openMessage",
          "Opens the conversation with Find in conversation on these words.",
        )}
      </p>
    </div>
  );
}

function conversationCount(count: number, t: UiTranslator): string {
  return t("palette.preview.conversationCount", {
    count,
    defaultValue_zero: "{{count, number}} conversations",
    defaultValue_one: "{{count, number}} conversation",
    defaultValue_other: "{{count, number}} conversations",
  });
}

function ProjectPreview({ entry }: { entry: ProjectEntry }): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="cp-preview-inner">
      <header className="cp-preview-head">
        <span className="cp-preview-glyph">
          <ProjectBadge projectId={entry.project.id} size="md" />
        </span>
        <div className="min-w-0">
          <h2 className="cp-preview-title">{entry.project.name}</h2>
          <p className="cp-preview-sub cp-path break-all">{entry.project.path}</p>
        </div>
      </header>
      <dl className="cp-facts">
        <Fact label={t("palette.preview.active", "Active")}>
          <span>{conversationCount(entry.activeCount, t)}</span>
        </Fact>
        <Fact label={t("palette.status.archived", "Archived")}>
          <span>{conversationCount(entry.archivedCount, t)}</span>
        </Fact>
      </dl>
      <p className="cp-preview-sub">
        {t("palette.preview.openProject", "Opens its most recent conversation. Tab for more.")}
      </p>
    </div>
  );
}

export interface PalettePreviewProps {
  entry: PaletteEntry | null;
  projectNames: ReadonlyMap<number, string>;
  activeProjectId: number | null;
  activeFeatureId: number | null;
  now: number;
}

/** Detail for the selected result; the rows stay one line. */
export const PalettePreview = memo(function PalettePreview({
  entry,
  projectNames,
  activeProjectId,
  activeFeatureId,
  now,
}: PalettePreviewProps): ReactElement {
  const { t } = useUiTranslation();
  if (!entry)
    return <div className="cp-preview-empty">{t("palette.preview.empty", "Nothing selected")}</div>;
  switch (entry.kind) {
    case "conversation":
      return (
        <ConversationPreview
          entry={entry}
          projectName={projectNames.get(entry.conversation.project_id)}
          now={now}
        />
      );
    case "command":
      return <CommandPreview entry={entry} />;
    case "file":
      return <FilePreview entry={entry} projectId={activeProjectId} featureId={activeFeatureId} />;
    case "message":
      return (
        <MessagePreview
          entry={entry}
          projectName={projectNames.get(entry.hit.project_id)}
          now={now}
        />
      );
    case "project":
      return <ProjectPreview entry={entry} />;
  }
});

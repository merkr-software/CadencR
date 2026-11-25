import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
import {
  ArchiveRestoreIcon,
  ArrowRightIcon,
  ClipboardIcon,
  CodeIcon,
  GitBranchIcon,
  MailIcon,
  MessageSquarePlusIcon,
  PinIcon,
  PinOffIcon,
  ScanSearchIcon,
  SquarePenIcon,
} from "lucide-react";
import type { ConversationIndexEntry } from "@/api/generated";
import { copyToClipboard } from "@/lib/clipboard";
import type { PaletteCommand, PaletteEntry } from "@/lib/command-palette/palette-types";
import { useUnreadStore } from "@/stores/unread-store";
import { snippetPlainText } from "./PaletteText";
import type { PaletteOperations } from "./usePaletteOperations";

export interface ItemActionContext {
  t: UiTranslator;
  ops: PaletteOperations;
  activeFeatureId: number | null;
  conversations: readonly ConversationIndexEntry[];
  /** What Enter does on the row: always the first action. It closes the palette itself. */
  primary: () => void;
}

const primaryAction = (title: string, icon: PaletteCommand["icon"], context: ItemActionContext) =>
  action("open", title, icon, undefined, { stay: context.primary });

function action(
  id: string,
  title: string,
  icon: PaletteCommand["icon"],
  run: PaletteCommand["run"],
  extra: Partial<PaletteCommand> = {},
): PaletteCommand {
  return { id, title, icon, run, group: "Conversation", ...extra };
}

function conversationActions(
  conversation: ConversationIndexEntry,
  context: ItemActionContext,
): PaletteCommand[] {
  const { t } = context;
  const archived = conversation.status === "archived";
  const actions = [
    primaryAction(
      t("palette.actions.openConversation", "Open conversation"),
      <ArrowRightIcon />,
      context,
    ),
  ];
  if (archived) {
    actions.push(
      action(
        "restore",
        t("palette.actions.restore", "Restore conversation"),
        <ArchiveRestoreIcon />,
        () => {
          context.ops.restore(conversation.id);
          context.ops.openConversation(conversation.project_id, conversation.id);
        },
        {
          description: t(
            "palette.actions.restoreDescription",
            "Moves it back to the active conversations and opens it.",
          ),
        },
      ),
    );
  } else {
    actions.push(
      conversation.is_pinned
        ? action("unpin", t("sidebar.row.unpin", "Unpin"), <PinOffIcon />, () =>
            context.ops.setPinned(conversation.id, false),
          )
        : action(
            "pin",
            t("sidebar.row.pin", "Pin"),
            <PinIcon />,
            () => context.ops.setPinned(conversation.id, true),
            {
              description: t(
                "palette.actions.pinDescription",
                "Keeps it in the sidebar's Pinned block.",
              ),
            },
          ),
      action("unread", t("palette.actions.unread", "Mark as unread"), <MailIcon />, () =>
        useUnreadStore.getState().markUnread(conversation.id),
      ),
    );
  }
  actions.push(
    action(
      "new-here",
      t("palette.actions.newInThisProject", "New conversation in this project"),
      <SquarePenIcon />,
      () => context.ops.createConversation({ projectId: conversation.project_id }),
    ),
    action("copy-title", t("palette.actions.copyTitle", "Copy title"), <ClipboardIcon />, () =>
      copyToClipboard(
        conversation.title,
        translateUi("palette.actions.titleCopied", "Title copied"),
      ),
    ),
  );
  if (conversation.worktree_branch) {
    const branch = conversation.worktree_branch;
    actions.push(
      action(
        "copy-branch",
        t("palette.actions.copyBranch", "Copy branch name"),
        <GitBranchIcon />,
        () =>
          copyToClipboard(
            branch,
            translateUi("palette.actions.branchCopied", "Branch name copied"),
          ),
      ),
    );
  }
  return actions;
}

/** What Tab offers for a result, its Enter action first. */
export function itemActions(entry: PaletteEntry, context: ItemActionContext): PaletteCommand[] {
  const { t } = context;
  switch (entry.kind) {
    case "conversation":
      return conversationActions(entry.conversation, context);
    case "project": {
      const { project } = entry;
      return [
        primaryAction(
          t("palette.actions.openLatest", "Open latest conversation"),
          <ArrowRightIcon />,
          context,
        ),
        action(
          "new-here",
          t("palette.commands.new-conversation-here.title", "New conversation in {{project}}", {
            project: project.name,
          }),
          <SquarePenIcon />,
          () => context.ops.createConversation({ projectId: project.id }),
        ),
        action(
          "new-choose",
          t("palette.commands.new-conversation.title", "New conversation…"),
          <MessageSquarePlusIcon />,
          undefined,
          {
            step: { kind: "worktree", projectId: project.id },
            description: t(
              "palette.actions.newDescription",
              "Choose a new worktree, the project directory or an existing branch.",
            ),
          },
        ),
        action("copy-path", t("palette.actions.copyPath", "Copy path"), <ClipboardIcon />, () =>
          copyToClipboard(project.path, translateUi("palette.actions.pathCopied", "Path copied")),
        ),
      ];
    }
    case "file":
      return [
        primaryAction(t("palette.actions.openEditor", "Open in Editor"), <CodeIcon />, context),
        action("copy-path", t("palette.actions.copyPath", "Copy path"), <ClipboardIcon />, () =>
          copyToClipboard(entry.path, translateUi("palette.actions.pathCopied", "Path copied")),
        ),
      ];
    case "message": {
      const { hit } = entry;
      return [
        primaryAction(
          t("palette.actions.openMessage", "Open and find these words"),
          <ScanSearchIcon />,
          context,
        ),
        action(
          "open-plain",
          t("palette.actions.openConversation", "Open conversation"),
          <ArrowRightIcon />,
          () => context.ops.openConversation(hit.project_id, hit.feature_id),
        ),
        action(
          "copy",
          t("palette.actions.copyExcerpt", "Copy message excerpt"),
          <ClipboardIcon />,
          () =>
            copyToClipboard(
              snippetPlainText(hit.snippet),
              translateUi("palette.actions.excerptCopied", "Excerpt copied"),
            ),
        ),
      ];
    }
    case "command":
      return [{ ...primaryAction(entry.command.title, entry.command.icon, context), id: "run" }];
  }
}

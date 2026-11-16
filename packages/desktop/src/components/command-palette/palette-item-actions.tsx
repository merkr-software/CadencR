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

const copy = (text: string, what: string) => copyToClipboard(text, `${what} copied`);

export interface ItemActionContext {
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
  const archived = conversation.status === "archived";
  const actions = [primaryAction("Open conversation", <ArrowRightIcon />, context)];
  if (archived) {
    actions.push(
      action(
        "restore",
        "Restore conversation",
        <ArchiveRestoreIcon />,
        () => {
          context.ops.restore(conversation.id);
          context.ops.openConversation(conversation.project_id, conversation.id);
        },
        { description: "Moves it back to the active conversations and opens it." },
      ),
    );
  } else {
    actions.push(
      conversation.is_pinned
        ? action("unpin", "Unpin", <PinOffIcon />, () =>
            context.ops.setPinned(conversation.id, false),
          )
        : action("pin", "Pin", <PinIcon />, () => context.ops.setPinned(conversation.id, true), {
            description: "Keeps it in the sidebar's Pinned block.",
          }),
      action("unread", "Mark as unread", <MailIcon />, () =>
        useUnreadStore.getState().markUnread(conversation.id),
      ),
    );
  }
  actions.push(
    action("new-here", "New conversation in this project", <SquarePenIcon />, () =>
      context.ops.createConversation({ projectId: conversation.project_id }),
    ),
    action("copy-title", "Copy title", <ClipboardIcon />, () => copy(conversation.title, "Title")),
  );
  if (conversation.worktree_branch) {
    const branch = conversation.worktree_branch;
    actions.push(
      action("copy-branch", "Copy branch name", <GitBranchIcon />, () =>
        copy(branch, "Branch name"),
      ),
    );
  }
  return actions;
}

/** What Tab offers for a result, its Enter action first. */
export function itemActions(entry: PaletteEntry, context: ItemActionContext): PaletteCommand[] {
  switch (entry.kind) {
    case "conversation":
      return conversationActions(entry.conversation, context);
    case "project": {
      const { project } = entry;
      return [
        primaryAction("Open latest conversation", <ArrowRightIcon />, context),
        action("new-here", `New conversation in ${project.name}`, <SquarePenIcon />, () =>
          context.ops.createConversation({ projectId: project.id }),
        ),
        action("new-choose", "New conversation…", <MessageSquarePlusIcon />, undefined, {
          step: { kind: "worktree", projectId: project.id },
          description: "Choose a new worktree, the project directory or an existing branch.",
        }),
        action("copy-path", "Copy path", <ClipboardIcon />, () => copy(project.path, "Path")),
      ];
    }
    case "file":
      return [
        primaryAction("Open in Editor", <CodeIcon />, context),
        action("copy-path", "Copy path", <ClipboardIcon />, () => copy(entry.path, "Path")),
      ];
    case "message": {
      const { hit } = entry;
      return [
        primaryAction("Open and find these words", <ScanSearchIcon />, context),
        action("open-plain", "Open conversation", <ArrowRightIcon />, () =>
          context.ops.openConversation(hit.project_id, hit.feature_id),
        ),
        action("copy", "Copy message excerpt", <ClipboardIcon />, () =>
          copy(snippetPlainText(hit.snippet), "Excerpt"),
        ),
      ];
    }
    case "command":
      return [{ ...primaryAction(entry.command.title, entry.command.icon, context), id: "run" }];
  }
}

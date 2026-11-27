import { useUiTranslation, UiTrans } from "@/lib/i18n/ui";
import { useEffect, useRef, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { KbdShortcut } from "@/components/KbdShortcut";
import { useIsMobile } from "@/hooks/useIsMobile";
import { parseUTCDateTime } from "@/lib/date-utils";
import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { cn } from "@/lib/utils";

export interface DiffComment {
  id: number;
  feature_id: number;
  file_path: string;
  line_number: number;
  side: "old" | "new";
  content: string;
  status: "pending" | "sent" | "resolved";
  created_at: string;
}

/**
 * Inline comment form that appears when clicking the "+" button on a diff line.
 */
export function CommentForm({
  onSubmit,
  onClose,
  initialContent = "",
  submitLabel,
}: {
  onSubmit: (content: string) => void;
  onClose: () => void;
  initialContent?: string;
  submitLabel?: string;
}) {
  const { t } = useUiTranslation();
  const [content, setContent] = useState(initialContent);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isMobile = useIsMobile();
  const trimmed = content.trim();

  // Focus the textarea once the diff has slotted this form into place. Pierre
  // re-renders its tree synchronously as the annotation mounts, so deferring to
  // the next frame lets that settle — focus then lands on the real, positioned
  // field instead of racing Pierre's DOM work. `preventScroll` keeps the
  // browser's focus jump out of Pierre's `overflow: scroll` diff; we bring the
  // field into view ourselves with a minimal `block: "nearest"` scroll.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
      textarea.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(id);
  }, []);

  const submit = (): void => {
    if (trimmed) onSubmit(trimmed);
  };

  return (
    <div className="mx-3 my-2 overflow-hidden rounded-lg border border-[var(--editor-border)] bg-[var(--editor-bg)] font-sans shadow-sm">
      <textarea
        ref={textareaRef}
        className="block w-full resize-y border-0 bg-transparent px-3 py-2.5 font-sans text-sm !text-[var(--editor-fg)] placeholder-[var(--editor-comment)] focus:outline-none"
        placeholder={t("workspace.git.diffCommentWidget.addAComment", "Add a comment...")}
        rows={3}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2 border-t border-[var(--editor-border)] px-2.5 py-2">
        {/* Keyboard hints are useless without a physical keyboard — desktop only.
            `mr-auto` keeps the action buttons right-aligned when it's hidden. */}
        {!isMobile && (
          <span className="mr-auto flex items-center gap-1.5 text-[11px] !text-[var(--editor-comment)]">
            <UiTrans
              i18nKey="workspace.git.diffCommentWidget.commentShortcut"
              defaults="<shortcut /> to comment"
              components={{ shortcut: <KbdShortcut keys={["enter"]} variant="hint" /> }}
            />
          </span>
        )}
        <div className="flex items-center gap-1.5">
          <button
            className="rounded-md px-3 py-1.5 font-sans text-xs font-medium !text-[var(--editor-fg)] transition-colors hover:bg-[var(--editor-selection-bg)]"
            onClick={onClose}
          >
            {t("workspace.git.diffCommentWidget.cancel", "Cancel")}
          </button>
          <button
            className="rounded-md bg-[var(--editor-purple)] px-3 py-1.5 font-sans text-xs font-semibold text-[var(--editor-bg)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!trimmed}
            onClick={submit}
          >
            {submitLabel ?? t("workspace.git.diffCommentWidget.comment", "Comment")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Displays an existing comment with edit/delete actions.
 */
export function CommentDisplay({
  comment,
  onEdit,
  onDelete,
}: {
  comment: DiffComment;
  onEdit: (id: number, content: string) => void;
  onDelete: (id: number) => void;
}) {
  const { t, i18n } = useUiTranslation();
  const [isEditing, setIsEditing] = useState(false);

  if (isEditing) {
    return (
      <CommentForm
        initialContent={comment.content}
        submitLabel={t("workspace.git.diffCommentWidget.update", "Update")}
        onSubmit={(content) => {
          onEdit(comment.id, content);
          setIsEditing(false);
        }}
        onClose={() => setIsEditing(false)}
      />
    );
  }

  return (
    <div className="mx-3 my-2 rounded-lg border border-[var(--editor-border)] bg-[var(--editor-bg)] p-3 font-sans shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="flex-1 whitespace-pre-wrap text-sm !text-[var(--editor-fg)]">
          {comment.content}
        </p>
        <div className="flex shrink-0 gap-0.5">
          <button
            className="rounded-md p-1.5 !text-[var(--editor-comment)] transition-colors hover:bg-[var(--editor-selection-bg)] hover:!text-[var(--editor-fg)]"
            onClick={() => setIsEditing(true)}
            title={t("workspace.git.diffCommentWidget.editComment", "Edit comment")}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            className="rounded-md p-1.5 !text-[var(--editor-comment)] transition-colors hover:bg-[var(--editor-selection-bg)] hover:!text-[var(--editor-red)]"
            onClick={() => onDelete(comment.id)}
            title={t("workspace.git.diffCommentWidget.deleteComment", "Delete comment")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs !text-[var(--editor-comment)]">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase",
            comment.status === "pending"
              ? "bg-[var(--editor-orange)]/15 !text-[var(--editor-orange)]"
              : comment.status === "sent"
                ? "bg-[var(--editor-green)]/15 !text-[var(--editor-green)]"
                : "bg-[var(--editor-selection-bg)] !text-[var(--editor-comment)]",
          )}
        >
          {comment.status === "pending"
            ? t("workspace.git.diffCommentWidget.pending", "pending")
            : comment.status === "sent"
              ? t("workspace.git.diffCommentWidget.sent", "sent")
              : t("workspace.git.diffCommentWidget.resolved", "resolved")}
        </span>
        <span className="!text-[var(--editor-comment)]">
          {parseUTCDateTime(comment.created_at).toLocaleString(formattingLocale(i18n.language), {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
      </div>
    </div>
  );
}

/**
 * Widget line renderer: shows existing comments + new comment form for a line.
 */
export function CommentWidgetLine({
  comments,
  onClose,
  onSubmit,
  onEdit,
  onDelete,
}: {
  comments: DiffComment[];
  onClose: () => void;
  onSubmit: (content: string) => void;
  onEdit: (id: number, content: string) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <div className="border-t border-b border-[var(--editor-border)] bg-[var(--editor-bg)]">
      {comments.map((c) => (
        <CommentDisplay key={c.id} comment={c} onEdit={onEdit} onDelete={onDelete} />
      ))}
      <CommentForm onSubmit={onSubmit} onClose={onClose} />
    </div>
  );
}

/**
 * Extend line renderer: shows existing comments inline (without the new comment form).
 */
export function CommentExtendLine({
  comments,
  onEdit,
  onDelete,
}: {
  comments: DiffComment[];
  onEdit: (id: number, content: string) => void;
  onDelete: (id: number) => void;
}) {
  if (comments.length === 0) return null;

  return (
    <div className="border-t border-[var(--editor-border)] bg-[var(--editor-bg)]">
      {comments.map((c) => (
        <CommentDisplay key={c.id} comment={c} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </div>
  );
}

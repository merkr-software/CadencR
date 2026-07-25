import { memo, useMemo, type ReactElement } from "react";
import { MessageSquarePlus, MessagesSquare } from "lucide-react";
import type { Project, ScheduleTarget } from "@/api/generated";
import { ProjectBadge } from "@/components/ProjectBadge";
import { cn } from "@/lib/utils";
import { ConversationPicker } from "./ConversationPicker";
import { PickerPlaceholder, SchedulePicker } from "./SchedulePicker";

export interface ScheduleTargetEditorProps {
  value: ScheduleTarget;
  onChange: (next: ScheduleTarget) => void;
  projects: Project[];
  /** Set when editing from a conversation's own composer: the target is fixed,
   *  so the form states it instead of offering a choice. */
  lockedToConversation?: boolean;
  /** Title of the already-targeted conversation, shown until the project's
   *  conversations load (or when it has since been archived). */
  targetedConversationTitle?: string | null;
}

/**
 * Picks *where* a schedule delivers.
 *
 * The two kinds are genuinely different products — "nudge this thread" versus
 * "start fresh work on a cadence" — so they get an explicit choice rather than
 * an inferred one. Both narrow by project; only the second asks for a title,
 * since an existing conversation already has one. The runtime settings live on
 * the composer below, where the session composer keeps them.
 */
export const ScheduleTargetEditor = memo(function ScheduleTargetEditor({
  value,
  onChange,
  projects,
  lockedToConversation,
  targetedConversationTitle,
}: ScheduleTargetEditorProps): ReactElement {
  const projectOptions = useMemo(
    () =>
      projects.map((project) => ({
        value: project.id,
        label: project.name,
        // The same badge the sidebar uses — a project is recognized by its
        // logo long before its name is read.
        icon: <ProjectBadge projectId={project.id} size="sm" />,
      })),
    [projects],
  );

  if (lockedToConversation) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
        <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">This conversation</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <TargetKindCard
          selected={value.kind === "new_conversation"}
          icon={<MessageSquarePlus className="size-4" />}
          title="New conversation"
          description="Starts a fresh session each run"
          onSelect={() =>
            onChange({
              ...value,
              kind: "new_conversation",
              project_id: value.project_id ?? projects[0]?.id,
              worktree_mode: value.worktree_mode ?? "skip",
            })
          }
        />
        <TargetKindCard
          selected={value.kind === "conversation"}
          icon={<MessagesSquare className="size-4" />}
          title="Existing conversation"
          description="Sends into a thread you already have"
          onSelect={() =>
            onChange({
              ...value,
              kind: "conversation",
              project_id: value.project_id ?? projects[0]?.id,
            })
          }
        />
      </div>

      <Field label="Project">
        {projects.length === 0 ? (
          <PickerPlaceholder>No projects yet — add one first.</PickerPlaceholder>
        ) : (
          <SchedulePicker
            ariaLabel="Project"
            options={projectOptions}
            value={value.project_id}
            placeholder="Pick a project…"
            searchPlaceholder="Search projects…"
            emptyLabel="No matching projects."
            onChange={(projectId) =>
              onChange({
                ...value,
                project_id: projectId,
                // The picked conversation lived in the project we just left.
                feature_id: undefined,
              })
            }
          />
        )}
      </Field>

      {value.kind === "conversation" && (
        <Field label="Conversation">
          <ConversationPicker
            projectId={value.project_id}
            featureId={value.feature_id}
            fallbackTitle={targetedConversationTitle}
            onChange={(featureId) => onChange({ ...value, feature_id: featureId })}
          />
        </Field>
      )}
    </div>
  );
});

function TargetKindCard({
  selected,
  icon,
  title,
  description,
  onSelect,
}: {
  selected: boolean;
  icon: ReactElement;
  title: string;
  description: string;
  onSelect: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:border-border hover:bg-accent/40",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <span className={selected ? "text-primary" : "text-muted-foreground"}>{icon}</span>
        {title}
      </span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactElement;
}): ReactElement {
  const hintId = useMemo(
    () => (hint ? `${label.replace(/\s+/g, "-")}-hint` : undefined),
    [hint, label],
  );
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && (
        <span id={hintId} className="text-[11px] text-muted-foreground/80">
          {hint}
        </span>
      )}
    </label>
  );
}

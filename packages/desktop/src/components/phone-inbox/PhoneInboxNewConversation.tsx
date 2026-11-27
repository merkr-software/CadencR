import type { ReactElement, ReactNode } from "react";
import { Loader2Icon, PlusIcon, SquarePenIcon } from "lucide-react";
import type { Project } from "@/api/generated";
import {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuTrigger,
} from "@/components/PhoneSheetMenu";
import { ProjectBadge } from "@/components/ProjectBadge";
import { Button } from "@/components/ui/button";
import { useStartConversation } from "@/hooks/useStartConversation";
import { useUiTranslation } from "@/lib/i18n/ui";

interface NewConversationProps {
  projects: readonly Project[];
  /** The header's icon button, or the empty inbox's labelled button. */
  variant: "icon" | "button";
}

/**
 * The inbox's "New conversation" (`useStartConversation`, the sidebar "+"):
 * straight into the only project, or a sheet of projects to pick from when
 * there are several. Nothing to start without a project.
 */
export function NewConversation({ projects, variant }: NewConversationProps): ReactElement | null {
  const { t } = useUiTranslation();
  const label = t("palette.steps.newConversation", "New conversation");
  const { start, isPending } = useStartConversation();
  const only = projects.length === 1 ? projects[0] : undefined;
  if (projects.length === 0) return null;
  const trigger = (props: { onClick?: () => void }): ReactElement =>
    variant === "icon" ? (
      <Button
        variant="ghost"
        size="icon"
        className="size-11 shrink-0"
        aria-label={label}
        title={label}
        disabled={isPending}
        {...props}
      >
        {isPending ? (
          <Loader2Icon className="size-5 animate-spin" />
        ) : (
          <SquarePenIcon className="size-5" />
        )}
      </Button>
    ) : (
      <Button className="mt-4 min-h-11" disabled={isPending} {...props}>
        {isPending ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
        {label}
      </Button>
    );
  if (only) return trigger({ onClick: () => start(only.id) });
  return (
    <ProjectPicker projects={projects} onPick={start}>
      {trigger({})}
    </ProjectPicker>
  );
}

function ProjectPicker({
  projects,
  onPick,
  children,
}: {
  projects: readonly Project[];
  onPick: (projectId: number) => void;
  children: ReactNode;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <AdaptiveMenu>
      <AdaptiveMenuTrigger asChild>{children}</AdaptiveMenuTrigger>
      <AdaptiveMenuContent
        align="end"
        sheetTitle={t("phone.inbox.newConversationIn", "New conversation in")}
        sheetTitleVisible
      >
        {projects.map((project) => (
          <AdaptiveMenuItem key={project.id} onSelect={() => onPick(project.id)}>
            <ProjectBadge projectId={project.id} />
            <span className="min-w-0 truncate">{project.name}</span>
          </AdaptiveMenuItem>
        ))}
      </AdaptiveMenuContent>
    </AdaptiveMenu>
  );
}

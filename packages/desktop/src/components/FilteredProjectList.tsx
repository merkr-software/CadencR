import type { ReactElement, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import {
  useSidebarFilterMatches,
  type FilterableProject,
  type ProjectFilterMatch,
} from "@/hooks/useSidebarFilterMatches";

/**
 * The project list while the sidebar filter is active: only projects with a
 * match, each forced open on its matching conversations (or all of them when
 * the project's own name matched).
 */
export function FilteredProjectList<P extends FilterableProject>({
  projects,
  query,
  renderProject,
}: {
  projects: readonly P[];
  query: string;
  renderProject: (project: P, match: ProjectFilterMatch) => ReactNode;
}): ReactElement {
  const { matches, isLoading } = useSidebarFilterMatches(projects, query);
  return (
    <>
      {projects.map((project) => {
        const match = matches.get(project.id);
        return match === undefined ? null : renderProject(project, match);
      })}
      {isLoading ? (
        <p className="flex items-center justify-center gap-1.5 px-2 py-3 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          Searching projects…
        </p>
      ) : matches.size === 0 ? (
        <p className="px-2 py-4 text-center text-xs text-muted-foreground">
          No conversation matches “{query}”
        </p>
      ) : null}
    </>
  );
}

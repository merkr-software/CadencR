import { useUiTranslation } from "@/lib/i18n/ui";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ImageOff } from "lucide-react";
import type { ProjectIconCandidate } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useObjectUrl } from "@/hooks/useObjectUrl";
import { projectIconBlob, projectIconQueryKey } from "@/lib/project-icon";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/diff-thresholds";

/**
 * How many candidates render before the user asks for more. A repo can return
 * up to 40, and every tile fetches its own thumbnail — showing them all at once
 * would fire 40 requests for results the user will almost never scroll to,
 * since ranking puts the real logo in the first row.
 */
const INITIAL_VISIBLE = 12;

/** A single candidate tile: thumbnail, name, and selected state. */
function CandidateTile({
  projectId,
  candidate,
  selected,
  onSelect,
}: {
  projectId: number;
  candidate: ProjectIconCandidate;
  selected: boolean;
  onSelect: (path: string) => void;
}): React.JSX.Element {
  const { data: blob, isLoading } = useQuery({
    queryKey: projectIconQueryKey(projectId, candidate.path),
    queryFn: ({ signal }) => projectIconBlob(projectId, { path: candidate.path, signal }),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const url = useObjectUrl(blob);
  const [failed, setFailed] = useState(false);

  return (
    <button
      type="button"
      onClick={() => onSelect(candidate.path)}
      title={`${candidate.path} · ${formatBytes(candidate.size_bytes)}`}
      aria-pressed={selected}
      className={cn(
        "group relative flex flex-col items-center gap-1.5 rounded-md border p-2 transition-colors",
        "hover:border-primary/60 hover:bg-accent",
        selected ? "border-primary bg-accent" : "border-border",
      )}
    >
      <div className="flex size-10 items-center justify-center">
        {isLoading ? (
          <Skeleton className="size-9 rounded" />
        ) : url && !failed ? (
          <img
            src={url}
            alt=""
            aria-hidden
            onError={() => setFailed(true)}
            className="max-h-10 max-w-10 object-contain"
          />
        ) : (
          <ImageOff className="size-4 text-muted-foreground" />
        )}
      </div>
      <span className="w-full truncate text-center text-[11px] text-muted-foreground">
        {candidate.name}
      </span>
      {selected ? (
        <Check className="absolute right-1 top-1 size-3 text-primary" aria-hidden />
      ) : null}
    </button>
  );
}

/**
 * Grid of logo candidates found by the repository scan, best guess first.
 * Selecting a tile persists that path as the project icon.
 */
export function ProjectIconCandidateGrid({
  projectId,
  candidates,
  selectedPath,
  onSelect,
}: {
  projectId: number;
  candidates: ProjectIconCandidate[];
  selectedPath: string;
  onSelect: (path: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? candidates : candidates.slice(0, INITIAL_VISIBLE);
  const hidden = candidates.length - visible.length;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {visible.map((candidate) => (
          <CandidateTile
            key={candidate.path}
            projectId={projectId}
            candidate={candidate}
            selected={candidate.path === selectedPath}
            onSelect={onSelect}
          />
        ))}
      </div>
      {hidden > 0 ? (
        <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
          {t("project.iconCandidateGrid.showMore", "Show {{count}} more", { count: hidden })}
        </Button>
      ) : null}
    </div>
  );
}

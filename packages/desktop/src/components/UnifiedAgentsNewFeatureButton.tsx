import { memo, useCallback, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";
import {
  getListFeaturesQueryKey,
  useCreateFeature,
  type CreateFeatureResponse,
  type Project,
} from "@/api/generated";
import { ProjectColorDot } from "@/hooks/useProjectColor";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useGlobalShortcutById } from "@/hooks/useShortcut";

interface UnifiedAgentsNewFeatureButtonProps {
  projects: Project[];
}

/** "Add" button beside Refresh: opens a project combobox and creates a new
 *  feature in the chosen project, then navigates to it. Mirrors the global
 *  "New session" creation payload (no title/worktree — the backend defaults).
 *  ⌘⇧N opens the popover; the combobox input auto-focuses. */
export const UnifiedAgentsNewFeatureButton = memo(function UnifiedAgentsNewFeatureButton({
  projects,
}: UnifiedAgentsNewFeatureButtonProps): ReactElement {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createFeature = useCreateFeature({
    mutation: {
      onSuccess: (result: CreateFeatureResponse, variables): void => {
        void queryClient.invalidateQueries({
          queryKey: getListFeaturesQueryKey({ project_id: variables.data.project_id }),
        });
        void navigate({
          to: "/projects/$projectId/features/$featureId",
          params: {
            projectId: String(variables.data.project_id),
            featureId: String(result.id),
          },
        });
      },
      onError: (error: unknown): void => {
        toast.error(error instanceof Error ? error.message : "Failed to create feature");
      },
    },
  });

  const selectProject = useCallback(
    (projectId: number): void => {
      setOpen(false);
      createFeature.mutate({ data: { project_id: projectId, type: "ws-session" } });
    },
    [createFeature],
  );

  useGlobalShortcutById("agents-new-feature", (event: KeyboardEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    setOpen(true);
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ShortcutTooltip label="New session" keys={["cmd", "shift", "N"]} alignRight disabled={open}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="h-9 gap-1.5 rounded-lg border border-border/80 px-3 text-xs"
            aria-label="New session"
          >
            <PlusIcon className="size-3.5" />
            New
          </Button>
        </PopoverTrigger>
      </ShortcutTooltip>
      <PopoverContent
        align="end"
        className="w-[260px] p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        <Command>
          <CommandInput ref={inputRef} placeholder="Select a project…" className="h-9 text-xs" />
          <CommandList className="max-h-[320px]">
            <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">
              No projects found.
            </CommandEmpty>
            <CommandGroup>
              {projects.map((project) => (
                <CommandItem
                  key={project.id}
                  // Include the id so two projects sharing a folder name don't
                  // collapse to one cmdk value; the name keeps it searchable.
                  value={`${project.name} ${project.id}`}
                  onSelect={() => selectProject(project.id)}
                  className="gap-2 text-xs"
                >
                  <ProjectColorDot projectId={project.id} className="size-2" />
                  <span className="truncate">{project.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
});

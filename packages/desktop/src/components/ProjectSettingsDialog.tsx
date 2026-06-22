import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetProjectSettings,
  useSetProjectSetting,
  getGetProjectSettingsQueryKey,
} from "../api/generated";
import { GitBranch, TerminalSquare } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ModelSelector } from "./ModelSelector";
import { WorktreeList } from "./WorktreeList";
import { ShellTerminalFrame } from "./ShellTerminalFrame";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { IconTile } from "@/components/settings/IconTile";
import { ProjectColorPicker } from "@/components/settings/ProjectColorPicker";
import { ProjectJsonSettings } from "@/components/settings/SettingsJsonControls";
import { ProjectEditorToolingSettings } from "@/components/settings/ProjectEditorToolingSettings";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";

export function ProjectSettingsDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
}: {
  projectId: number;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data: settingsArray } = useGetProjectSettings(projectId, { query: { enabled: open } });
  const settings: Record<string, string> = {};
  if (settingsArray) {
    for (const s of settingsArray) {
      if (s.value != null) settings[s.key] = s.value;
    }
  }
  // Toast only the user-driven saves — the field-level autosave fires often
  // enough that a per-keystroke toast would be noise. We surface "Saved" on
  // explicit color picker clicks via the swatch's onChange.
  const setSettingMutation = useSetProjectSetting({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetProjectSettingsQueryKey(projectId) });
      },
      onError: (err: Error) => {
        toast.error(err.message);
      },
    },
  });

  const [branchPrefix, setBranchPrefix] = useState(settings?.branch_prefix ?? "");
  const [colorInput, setColorInput] = useState(settings?.color ?? "");
  const [setupWorktree, setSetupWorktree] = useState(settings?.setup_worktree ?? "");
  useEffect(() => {
    if (settings?.color != null) setColorInput(settings.color);
  }, [settings?.color]);
  useEffect(() => {
    if (settings?.setup_worktree != null) setSetupWorktree(settings.setup_worktree);
  }, [settings?.setup_worktree]);
  useEffect(() => {
    if (settings?.branch_prefix != null) setBranchPrefix(settings.branch_prefix);
  }, [settings?.branch_prefix]);

  // Debounced text-field saves. `useDebouncedCallback` handles timer cleanup
  // on unmount so a fast typist closing the dialog won't fire a mutation on
  // an unmounted component. Color is committed immediately because swatch
  // clicks aren't continuous.
  const commitBranchPrefix = useDebouncedCallback((next: string) => {
    setSettingMutation.mutate({
      id: projectId,
      data: { key: "branch_prefix", value: next },
    });
  }, 400);

  const commitSetupWorktree = useDebouncedCallback((next: string) => {
    setSettingMutation.mutate({
      id: projectId,
      data: { key: "setup_worktree", value: next },
    });
  }, 600);

  function commitColor(next: string): void {
    setColorInput(next);
    setSettingMutation.mutate({
      id: projectId,
      data: { key: "color", value: next },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[90vw] flex-col gap-0 p-0 sm:max-w-6xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-semibold">
            Project settings — <span className="text-muted-foreground">{projectName}</span>
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground">Changes save automatically.</p>
        </DialogHeader>

        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
          <SettingsSection size="sm" title="Configuration" subtitle="Edit JSON · Copy path">
            <SettingsCard padded>
              <ProjectJsonSettings projectId={projectId} enabled={open} />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection size="sm" title="Identity" subtitle="Color · Display">
            <SettingsCard padded>
              <div className="space-y-2">
                <div className="text-sm font-medium">Project color</div>
                <p className="text-xs text-muted-foreground">
                  Accent dot used for this project in the sidebar.
                </p>
                <ProjectColorPicker value={colorInput} onChange={commitColor} />
              </div>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection
            size="sm"
            title="Editor Tooling"
            subtitle="Language servers · Formatter"
            description="Type checker, linter, and formatter for this project's editor. Each falls back to the global default when unset."
          >
            <SettingsCard padded>
              <ProjectEditorToolingSettings projectId={projectId} enabled={open} />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection
            size="sm"
            title="Runtime & Models"
            subtitle="Per-agent model picks"
            description="Override the runtime/model used for each agent inside this project."
          >
            <SettingsCard>
              <ModelSelector level="project" projectId={projectId} />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection
            size="sm"
            title="Git & Automation"
            subtitle="Worktree defaults"
            description="Defaults applied to worktrees created for this project."
          >
            <SettingsCard padded className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="branch-prefix" className="text-sm font-medium">
                  Branch prefix
                </label>
                <p className="text-xs text-muted-foreground">
                  Prefix added to worktree branch names.
                </p>
                <div className="flex items-center gap-2">
                  <IconTile tint="cyan">
                    <GitBranch className="size-4" />
                  </IconTile>
                  <Input
                    id="branch-prefix"
                    placeholder="e.g. feature/"
                    value={branchPrefix}
                    onChange={(e) => {
                      setBranchPrefix(e.target.value);
                      commitBranchPrefix(e.target.value);
                    }}
                    className="h-8 text-sm"
                  />
                </div>
              </div>

              <div className="border-t border-border" />

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <IconTile tint="green">
                    <TerminalSquare className="size-4" />
                  </IconTile>
                  <div>
                    <div className="text-sm font-medium">Worktree setup commands</div>
                    <p className="text-xs text-muted-foreground">
                      Shell commands to run after creating a worktree (one per line).
                    </p>
                  </div>
                </div>
                <ShellTerminalFrame subtitle="one command per line" bodyClassName="p-0">
                  <Textarea
                    placeholder={
                      "pnpm install\ncp packages/service/.env.example packages/service/.env"
                    }
                    rows={4}
                    value={setupWorktree}
                    onChange={(e) => {
                      setSetupWorktree(e.target.value);
                      commitSetupWorktree(e.target.value);
                    }}
                    className="min-h-24 resize-y rounded-none border-0 bg-[var(--block-bash-body-bg)] font-mono text-xs leading-relaxed text-[var(--block-bash-fg)] placeholder:text-muted-foreground/60 focus-visible:ring-0 focus-visible:ring-offset-0"
                  />
                </ShellTerminalFrame>
              </div>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection
            size="sm"
            title="Worktrees"
            subtitle="Active checkouts"
            description="Git worktrees created for this project's features."
          >
            <SettingsCard padded>
              <WorktreeList projectId={projectId} />
            </SettingsCard>
          </SettingsSection>
        </div>
      </DialogContent>
    </Dialog>
  );
}

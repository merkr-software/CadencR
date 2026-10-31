import { useState, type ReactElement } from "react";

import { useListProjects } from "@/api/generated";
import { ResolvedKbdChord } from "@/components/KbdShortcut";
import { CustomActionsManager } from "@/components/custom-actions/CustomActionsManager";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { SettingsPageSection } from "@/components/settings/SettingsPageSection";
import { SettingsSubsection } from "@/components/settings/SettingsSubsection";
import type { SettingsPageId } from "@/components/settings/settings-catalog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const CUSTOM_ACTIONS_SECTION_ID = "actions" satisfies SettingsPageId;

/**
 * Settings → Custom actions: the one place to see and arrange every action.
 * Global actions first (every project's header shows them after its own), then
 * any project's own list, picked from a menu — the same list its Project
 * settings show.
 */
export function CustomActionsSettingsSection(): ReactElement {
  const { data: projects = [] } = useListProjects();
  const [projectId, setProjectId] = useState<number | null>(null);
  const shownProjectId = projectId ?? projects[0]?.id ?? null;
  return (
    <SettingsPageSection
      pageId={CUSTOM_ACTIONS_SECTION_ID}
      description={
        <>
          Commands you run often in a conversation's working copy: tests, linters, deploys, dev
          servers. Each project's header lists its own actions, then the global ones, in the order
          below. Run them from the header launcher, the Actions tab, or{" "}
          <ResolvedKbdChord shortcutId="custom-action-run-1-9" />.
        </>
      }
    >
      <SettingsGroup title="All projects" description="Offered in every project's conversations.">
        <SettingsSubsection>
          <CustomActionsManager scope="global" />
        </SettingsSubsection>
      </SettingsGroup>
      {projects.length > 0 && shownProjectId != null && (
        <SettingsGroup
          title="One project"
          description="Offered only in that project's conversations, before the global ones."
          action={
            <Select
              value={String(shownProjectId)}
              onValueChange={(value) => setProjectId(Number(value))}
            >
              <SelectTrigger size="sm" className="h-8 min-w-40" aria-label="Project">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {projects.map((project) => (
                  <SelectItem key={project.id} value={String(project.id)}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        >
          <SettingsSubsection>
            <CustomActionsManager key={shownProjectId} scope="project" projectId={shownProjectId} />
          </SettingsSubsection>
        </SettingsGroup>
      )}
    </SettingsPageSection>
  );
}

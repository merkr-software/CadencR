import { translateUi, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useCallback, useMemo, useState } from "react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  usePluginTabGetConfiguration,
  usePluginTabPutConfiguration,
  type PluginTabConfiguration,
  type PluginTabSummary,
  type Project,
} from "@/api/generated";
import { ErrorRow, LoadingRow } from "@/components/settings/SettingsStateRows";
import { apiErrorCode, apiErrorMessage, toastError } from "@/lib/api-errors";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { CustomTabConfigFields } from "./CustomTabConfigFields";
import { useKeptSaves } from "./kept-drafts";
import { SuppressingSelect } from "./SuppressingSelect";

const NO_VALUES: Record<string, unknown> = {};

/**
 * The form the tab's `configuration` declares: global fields once, project
 * fields for the project picked here. Each scope saves on its own, since the
 * service stores them apart (`project_id` omitted vs. given).
 */
export function CustomTabConfiguration({
  tab,
  projects,
}: {
  tab: PluginTabSummary;
  projects: Project[];
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const globalFields = tab.configuration.filter((field) => field.scope === "global");
  const projectFields = tab.configuration.filter((field) => field.scope === "project");
  const [projectId, setProjectId] = useState<number | null>(
    () => tab.authoring_project_id ?? projects[0]?.id ?? null,
  );
  const params =
    projectFields.length > 0 && projectId !== null ? { project_id: projectId } : undefined;
  // Switching projects keeps the previous answer on screen, so the global
  // form (and its unsaved draft) stays mounted while the new project loads.
  const query = usePluginTabGetConfiguration(tab.id, params, {
    query: { placeholderData: keepPreviousData },
  });
  const save = useSaveConfiguration(tab);

  const loadingLabel = t("customTabs.customTabConfiguration.loadingSettings", "Loading settings…");
  if (!query.data) {
    return query.error ? (
      <ConfigLoadError error={query.error} />
    ) : (
      <LoadingRow label={loadingLabel} />
    );
  }
  const data: PluginTabConfiguration = query.data;
  // Forms are keyed on what is stored, not on when it was fetched: a refetch
  // that changed nothing (a watcher event, the other scope's save) keeps the
  // user's draft; new stored values (a save, an edit elsewhere) reset it. A
  // scope's own save also resets its form (`onSave` resolving `true`), even
  // when the masked answer is unchanged (a replaced secret).
  const globalKey = `global:${JSON.stringify(data.global)}`;
  const projectKey = `project:${projectId}:${JSON.stringify(data.project ?? null)}`;
  const globalSlot = `${tab.id}:global`;
  const projectSlot = `${tab.id}:project:${projectId}`;

  return (
    <div className="space-y-5">
      {globalFields.length > 0 ? (
        <ScopeBlock title={t("customTabs.customTabConfiguration.allProjects", "All projects")}>
          <CustomTabConfigFields
            key={globalKey}
            draftSlot={{ id: globalSlot, version: globalKey }}
            fields={globalFields}
            stored={data.global}
            saving={save.of(globalSlot).saving}
            error={configurationError(save.of(globalSlot).error, t)}
            onSave={(values) => save.run(globalSlot, null, values)}
          />
        </ScopeBlock>
      ) : null}
      {projectFields.length > 0 ? (
        <ScopeBlock title={t("customTabs.customTabConfiguration.perProject", "Per project")}>
          {projects.length === 0 || projectId === null ? (
            <p className="text-xs text-muted-foreground">
              {t(
                "customTabs.customTabConfiguration.addAProjectToSetThese",
                "Add a project to set these.",
              )}
            </p>
          ) : (
            <div className="space-y-4">
              <SuppressingSelect
                ariaLabel={t(
                  "customTabs.customTabConfiguration.projectPickerLabel",
                  "Project to configure",
                )}
                value={String(projectId)}
                options={projects.map((project) => ({
                  value: String(project.id),
                  label: project.name,
                }))}
                onValueChange={(value) => setProjectId(Number(value))}
              />
              {query.isPlaceholderData ? (
                <LoadingRow label={loadingLabel} />
              ) : (
                <CustomTabConfigFields
                  key={projectKey}
                  draftSlot={{ id: projectSlot, version: projectKey }}
                  fields={projectFields}
                  stored={data.project ?? NO_VALUES}
                  saving={save.of(projectSlot).saving}
                  error={configurationError(save.of(projectSlot).error, t)}
                  onSave={(values) => save.run(projectSlot, projectId, values)}
                />
              )}
            </div>
          )}
        </ScopeBlock>
      ) : null}
    </div>
  );
}

function ConfigLoadError({ error }: { error: unknown }): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <ErrorRow
      label={apiErrorMessage(
        error,
        t("customTabs.customTabConfiguration.loadError", "Could not load the tab's settings."),
      )}
    />
  );
}

function configurationError(error: { cause: unknown } | null, t: UiTranslator): string | null {
  return error
    ? apiErrorMessage(
        error.cause,
        t("customTabs.customTabConfiguration.invalidValue", "Invalid value."),
      )
    : null;
}

function ScopeBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h5 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {title}
      </h5>
      {children}
    </section>
  );
}

/**
 * PUT one slot (a scope, or one project of it); the service's validation
 * message stays inline, anything else is a toast. Each slot's save is its
 * own: one settling must not unlock another's form.
 */
function useSaveConfiguration(tab: PluginTabSummary) {
  const queryClient = useQueryClient();
  const { mutateAsync } = usePluginTabPutConfiguration();
  const { of, update } = useKeptSaves();

  /**
   * `true` once saved and reloaded. `saving` lasts until then, so the form
   * stays locked and no edit made meanwhile is reset with the saved draft.
   */
  const run = useCallback(
    async (slot: string, projectId: number | null, values: Record<string, unknown>) => {
      update(slot, { saving: true, error: null });
      try {
        await mutateAsync({
          id: tab.id,
          data: { values },
          ...(projectId === null ? {} : { params: { project_id: projectId } }),
        });
      } catch (error: unknown) {
        if (apiErrorCode(error) === "PLUGIN_TAB_CONFIG_INVALID") {
          update(slot, { error: { cause: error } });
        } else {
          toastError(
            error,
            translateUi(
              "customTabs.customTabConfiguration.saveError",
              "Could not save the settings of “{{name}}”",
              { name: tab.name },
            ),
          );
        }
        update(slot, { saving: false });
        return false;
      }
      toast.success(
        translateUi("customTabs.customTabConfiguration.saveSuccess", "“{{name}}” settings saved", {
          name: tab.name,
        }),
      );
      try {
        await invalidateByUrlPrefix(queryClient, `/api/plugin-tabs/${tab.id}/configuration`);
      } catch (error: unknown) {
        // Saved either way; a failed reload only leaves the form showing the old values.
        toastError(
          error,
          translateUi(
            "customTabs.customTabConfiguration.savedReloadError",
            "Saved, but the settings could not be reloaded",
          ),
        );
      } finally {
        update(slot, { saving: false });
      }
      return true;
    },
    [mutateAsync, queryClient, tab.id, tab.name, update],
  );

  return useMemo(() => ({ run, of }), [of, run]);
}

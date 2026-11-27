import { useUiTranslation, translateUi, type UiTranslator } from "@/lib/i18n/ui";
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  getGetProjectSettingsQueryKey,
  setProjectSetting,
  setWorkspaceSetting,
  useGetProjectSettings,
} from "@/api/generated";
import {
  settingsArrayToMap,
  useGetWorkspaceSettings,
  getWorkspaceSettingsQueryKey,
} from "@/api/settings";
import { useLspMarketplace } from "@/hooks/useLspMarketplace";
import { catalogMembers } from "@/lib/marketplace-catalog";
import { apiErrorMessage } from "@/lib/api-errors";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Virtuoso } from "react-virtuoso";
import { useStableMutation } from "@/hooks/stable-query";
import { IgnoredLspSuggestions } from "./IgnoredLspSuggestions";
import { LanguageChoices } from "./LanguageChoices";
import { LabeledControl } from "./LabeledControl";

const KEY = "editor_lsp_languages";
const languageChoiceSchema = z.object({
  primary: z.string().nullable().optional(),
  linters: z.array(z.string()).optional(),
});
const choicesSchema = z.record(z.string(), languageChoiceSchema);
export type Choice = z.infer<typeof languageChoiceSchema>;

function useLanguageServerSettings(projectId?: number) {
  const { t } = useUiTranslation();
  const marketplace = useLspMarketplace();
  const global = useGetWorkspaceSettings();
  const project = useGetProjectSettings(projectId ?? 0, {
    query: { enabled: projectId !== undefined },
  });
  const globalMap = useMemo(() => settingsArrayToMap(global.data), [global.data]);
  const projectMap = useMemo(() => settingsArrayToMap(project.data), [project.data]);
  const raw = (projectId === undefined ? globalMap : projectMap)[KEY];
  const parsed = useMemo(() => {
    try {
      return { data: choicesSchema.parse(raw ? (JSON.parse(raw) as unknown) : {}), error: null };
    } catch (error) {
      return {
        data: {} as Record<string, Choice>,
        error,
      };
    }
  }, [raw]);
  const client = useQueryClient();
  const writable =
    !parsed.error &&
    !global.isPending &&
    !global.isError &&
    (projectId === undefined || (!project.isPending && !project.isError));
  const save = useStableMutation(
    useMutation({
      mutationFn: async ({ language, choice }: { language: string; choice: Choice }) => {
        if (!writable)
          throw new Error(
            translateUi(
              "workspace.editor.languageServers.choicesUnavailable",
              "Language choices are unavailable. Reload settings before saving.",
            ),
          );
        const value = JSON.stringify({ ...parsed.data, [language]: choice });
        if (projectId === undefined) await setWorkspaceSetting(KEY, { value });
        else await setProjectSetting(projectId, { key: KEY, value });
      },
      onSuccess: async () => {
        await Promise.all([
          client.invalidateQueries({
            queryKey:
              projectId === undefined
                ? getWorkspaceSettingsQueryKey()
                : getGetProjectSettingsQueryKey(projectId),
          }),
          client.invalidateQueries({ queryKey: ["/api/lsp/resolve"] }),
        ]);
      },
    }),
  );
  const languages = useMemo(() => {
    const catalogLanguages = catalogMembers(
      marketplace.catalog.data?.index?.signed.packages,
    ).flatMap((entry) =>
      entry.kind === "lsp" ? entry.package.lsp.languages.map((language) => language.id) : [],
    );
    const installedLanguages =
      marketplace.inventory.data?.servers.flatMap((server) => server.language_ids) ?? [];
    return [
      ...new Set([...catalogLanguages, ...installedLanguages, ...Object.keys(parsed.data)]),
    ].sort();
  }, [marketplace.catalog.data, marketplace.inventory.data, parsed.data]);
  const loading =
    global.isPending ||
    (projectId !== undefined && project.isPending) ||
    marketplace.inventory.isPending;
  const error = parsed.error
    ? apiErrorMessage(
        parsed.error,
        t("workspace.editor.languageServers.readChoicesFailed", "Could not read language choices"),
      )
    : global.error ||
        project.error ||
        marketplace.catalog.error ||
        marketplace.inventory.error ||
        save.error
      ? apiErrorMessage(
          global.error ??
            project.error ??
            marketplace.catalog.error ??
            marketplace.inventory.error ??
            save.error,
          t(
            "workspace.editor.languageServers.loadServersFailed",
            "Could not load language servers",
          ),
        )
      : null;
  return useMemo(
    () => ({ marketplace, languages, choices: parsed.data, save, loading, error, writable }),
    [marketplace, languages, parsed.data, save, loading, error, writable],
  );
}

/** Global defaults and project overrides use the same installed, data-driven choices. */
export function LanguageServerSettings({ projectId }: { projectId?: number }) {
  const { t } = useUiTranslation();
  const state = useLanguageServerSettings(projectId);
  const [selected, setSelected] = useState("");
  const language = state.languages.includes(selected) ? selected : (state.languages[0] ?? "");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t(
            "workspace.editor.languageServers.installServersInTheMarketplaceThenChoose",
            "Install servers in the marketplace, then choose a primary server and optional linters for each language.",
          )}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/marketplace" search={{ kind: "lsp" }}>
            {t("workspace.editor.languageServers.browseLanguageServers", "Browse language servers")}
          </Link>
        </Button>
      </div>
      {state.loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t(
            "workspace.editor.languageServers.loadingLanguageServers",
            "Loading language servers…",
          )}
        </p>
      ) : state.languages.length ? (
        <>
          <LabeledControl label={t("workspace.editor.languageServers.language", "Language")}>
            <Select value={language} onValueChange={setSelected}>
              <SelectTrigger
                size="sm"
                aria-label={t(
                  "workspace.editor.languageServers.languageServerLanguage",
                  "Language server language",
                )}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {state.languages.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </LabeledControl>
          <LanguageChoices
            key={`${projectId}:${language}`}
            projectId={projectId}
            language={language}
            choice={state.choices[language] ?? {}}
            save={(choice) => state.save.mutate({ language, choice })}
            saving={state.save.isPending || !state.writable}
          />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(
            "workspace.editor.languageServers.noLanguageServersInstalledBrowseTheMarketplace",
            "No language servers installed. Browse the marketplace to add language tools.",
          )}
        </p>
      )}
      {state.marketplace.catalog.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          {t(
            "workspace.editor.languageServers.checkingMarketplaceLanguages",
            "Checking marketplace languages…",
          )}
        </p>
      )}
      {state.save.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("workspace.editor.languageServers.savingLanguageChoices", "Saving language choices…")}
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
      {projectId !== undefined && <IgnoredLspSuggestions projectId={projectId} />}
      <InstalledServers servers={state.marketplace.inventory.data?.servers ?? []} />
    </div>
  );
}

export type Server = NonNullable<
  ReturnType<typeof useLspMarketplace>["inventory"]["data"]
>["servers"][number];
function InstalledServers({ servers }: { servers: Server[] }) {
  const { t } = useUiTranslation();
  if (!servers.length) return null;
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-xs font-medium">
        {t(
          "workspace.editor.languageServers.installedServers",
          "Installed servers · {{count, number}}",
          { count: servers.length },
        )}
      </p>
      <Virtuoso
        className="h-48"
        data={servers}
        computeItemKey={(_, server) => server.lsp_id}
        itemContent={(_, server) => (
          <div className="pb-2 text-xs">
            <Link
              to="/marketplace/$kind/$id"
              params={{ kind: "lsp", id: server.lsp_id }}
              className="font-medium hover:underline"
            >
              {server.name}
            </Link>
            <span className="ml-2 text-muted-foreground">
              {serverStatusLabel(server.status, t)} · {server.language_ids.join(", ")}
            </span>
            {server.error && (
              <p role="alert" className="text-destructive">
                {server.error}
              </p>
            )}
          </div>
        )}
      />
    </div>
  );
}

function serverStatusLabel(status: Server["status"], t: UiTranslator): string {
  switch (status) {
    case "managed":
      return t("workspace.editor.languageServers.statusManaged", "managed");
    case "on_path":
      return t("workspace.editor.languageServers.statusOnPath", "on PATH");
    case "legacy":
      return t("workspace.editor.languageServers.statusLegacy", "legacy");
    case "invalid":
      return t("workspace.editor.languageServers.statusInvalid", "invalid");
  }
}

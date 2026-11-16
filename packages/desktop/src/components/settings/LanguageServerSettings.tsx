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
import { useLspResolution } from "@/lib/lsp/useLspResolution";
import { catalogMembers } from "@/lib/marketplace-catalog";
import { apiErrorMessage } from "@/lib/api-errors";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { LabeledControl } from "./LabeledControl";

const KEY = "editor_lsp_languages";
const languageChoiceSchema = z.object({
  primary: z.string().nullable().optional(),
  linters: z.array(z.string()).optional(),
});
const choicesSchema = z.record(z.string(), languageChoiceSchema);
type Choice = z.infer<typeof languageChoiceSchema>;

function useLanguageServerSettings(projectId?: number) {
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
        error: apiErrorMessage(error, "Could not read language choices"),
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
          throw new Error("Language choices are unavailable. Reload settings before saving.");
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
  const error =
    parsed.error ??
    (global.error ||
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
          "Could not load language servers",
        )
      : null);
  return useMemo(
    () => ({ marketplace, languages, choices: parsed.data, save, loading, error, writable }),
    [marketplace, languages, parsed.data, save, loading, error, writable],
  );
}

/** Global defaults and project overrides use the same installed, data-driven choices. */
export function LanguageServerSettings({ projectId }: { projectId?: number }) {
  const state = useLanguageServerSettings(projectId);
  const [selected, setSelected] = useState("");
  const language = state.languages.includes(selected) ? selected : (state.languages[0] ?? "");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Install servers in the marketplace, then choose a primary server and optional linters for
          each language.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/marketplace" search={{ kind: "lsp" }}>
            Browse language servers
          </Link>
        </Button>
      </div>
      {state.loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading language servers…
        </p>
      ) : state.languages.length ? (
        <>
          <LabeledControl label="Language">
            <Select value={language} onValueChange={setSelected}>
              <SelectTrigger size="sm" aria-label="Language server language">
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
          No language servers installed. Browse the marketplace to add language tools.
        </p>
      )}
      {state.marketplace.catalog.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          Checking marketplace languages…
        </p>
      )}
      {state.save.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          Saving language choices…
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

type Server = NonNullable<
  ReturnType<typeof useLspMarketplace>["inventory"]["data"]
>["servers"][number];
function LanguageChoices({
  projectId,
  language,
  choice,
  save,
  saving,
}: {
  projectId?: number;
  language: string;
  choice: Choice;
  save: (choice: Choice) => void;
  saving: boolean;
}) {
  const resolved = useLspResolution({ language_id: language, project_id: projectId });
  const candidates = resolved.data?.candidates ?? [];
  const primary =
    choice.primary === undefined ? "inherit" : choice.primary === null ? "off" : choice.primary;
  const primaries = candidates.filter(
    (server) => server.role === "type_checker" || server.role === "general",
  );
  const linters = candidates.filter((server) => server.role === "linter");
  const selectedLinters = choice.linters ?? resolved.data?.linters ?? [];
  const extra =
    primary !== "inherit" &&
    primary !== "off" &&
    !primaries.some((server) => server.lsp_id === primary);
  return (
    <div className="space-y-3">
      <LabeledControl
        label="Primary server"
        hint={`Effective: ${resolved.data?.primary ?? "Off"}. ${projectId === undefined ? "Automatic uses the only installed compatible primary server; choose one when several are installed." : "Inherit uses the global default."}`}
      >
        <Select
          value={primary}
          disabled={saving || resolved.isPending}
          onValueChange={(value) => {
            const next = { ...choice };
            if (value === "inherit") delete next.primary;
            else next.primary = value === "off" ? null : value;
            save(next);
          }}
        >
          <SelectTrigger size="sm" aria-label="Primary language server">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">
              {projectId === undefined ? "Automatic" : "Inherit global default"}
            </SelectItem>
            <SelectItem value="off">Off</SelectItem>
            {primaries.map((server) => (
              <SelectItem key={server.lsp_id} value={server.lsp_id}>
                {server.name}
              </SelectItem>
            ))}
            {extra && <SelectItem value={primary}>{primary} (not installed)</SelectItem>}
          </SelectContent>
        </Select>
      </LabeledControl>
      <LinterChoices
        choice={choice}
        save={save}
        saving={saving || resolved.isPending}
        linters={linters}
        selectedLinters={selectedLinters}
        projectId={projectId}
      />
      {resolved.isPending && (
        <p role="status" className="text-xs text-muted-foreground">
          Resolving language choices…
        </p>
      )}
      {resolved.data?.catalog_warning && (
        <p role="status" className="text-xs text-muted-foreground">
          Catalog: {resolved.data.catalog_warning}
        </p>
      )}
      {(resolved.error || resolved.data?.error) && (
        <p role="alert" className="text-xs text-destructive">
          {resolved.error?.message ?? resolved.data?.error}
        </p>
      )}
    </div>
  );
}

function LinterChoices({
  choice,
  save,
  saving,
  linters,
  selectedLinters,
  projectId,
}: {
  choice: Choice;
  save: (choice: Choice) => void;
  saving: boolean;
  linters: Server[];
  selectedLinters: string[];
  projectId?: number;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">Linters</p>
      <label className="flex items-center gap-2 text-xs">
        <Checkbox
          checked={choice.linters === undefined}
          disabled={saving}
          onCheckedChange={(checked) => {
            const next = { ...choice };
            if (checked) delete next.linters;
            else next.linters = [...selectedLinters];
            save(next);
          }}
        />
        {projectId === undefined ? "Use default (no linters)" : "Inherit global linters"}
      </label>
      {linters.map((server) => (
        <label key={server.lsp_id} className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={selectedLinters.includes(server.lsp_id)}
            disabled={saving}
            onCheckedChange={(checked) =>
              save({
                ...choice,
                linters: checked
                  ? [...new Set([...selectedLinters, server.lsp_id])]
                  : selectedLinters.filter((id) => id !== server.lsp_id),
              })
            }
          />
          {server.name}
        </label>
      ))}
      {selectedLinters
        .filter((id) => !linters.some((server) => server.lsp_id === id))
        .map((id) => (
          <label key={id} className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked
              disabled={saving}
              onCheckedChange={() =>
                save({ ...choice, linters: selectedLinters.filter((selected) => selected !== id) })
              }
            />
            {id} (saved, not installed)
          </label>
        ))}
    </div>
  );
}

function InstalledServers({ servers }: { servers: Server[] }) {
  if (!servers.length) return null;
  return (
    <div className="space-y-2 border-t border-border pt-3">
      <p className="text-xs font-medium">Installed servers · {servers.length}</p>
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
              {server.status} · {server.language_ids.join(", ")}
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

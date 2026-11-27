import { useUiTranslation, translateUi } from "@/lib/i18n/ui";
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getGetProjectSettingsQueryKey,
  setProjectSetting,
  useGetProjectSettings,
} from "@/api/generated";
import { useLspMarketplace } from "@/hooks/useLspMarketplace";
import { apiErrorMessage } from "@/lib/api-errors";
import type { LspResolution } from "@/lib/lsp/useLspResolution";
import { z } from "zod";

const prompts = new Map<string, { owners: number; dismissed: boolean }>();
const ignoredSchema = z.array(z.string());
type Candidate = LspResolution["suggestions"][number];

/** One prompt per project/language, released when its last eligible editor closes. */
export function useLspSuggestion(projectId: number, resolution: LspResolution | undefined): void {
  const navigate = useNavigate();
  const language = resolution?.language_id;
  const eligible =
    !!resolution?.suggestions.length && !resolution.ignored && !resolution.primary_disabled;
  const candidates = JSON.stringify(resolution?.suggestions ?? []);
  useEffect(() => {
    if (!eligible || !language) return;
    const key = `lsp-suggestion:${projectId}:${language}`;
    const prompt = prompts.get(key) ?? { owners: 0, dismissed: false };
    prompts.set(key, prompt);
    prompt.owners += 1;
    const dismiss = () => {
      prompt.dismissed = true;
      toast.dismiss(key);
    };
    if (!prompt.dismissed)
      toast.custom(
        () => (
          <Suggestion
            projectId={projectId}
            language={language}
            candidates={JSON.parse(candidates) as Candidate[]}
            dismiss={dismiss}
            alternatives={() => {
              dismiss();
              void navigate({ to: "/marketplace", search: { kind: "lsp" } });
            }}
          />
        ),
        { id: key, duration: Infinity },
      );
    return () => {
      prompt.owners -= 1;
      if (!prompt.owners) {
        toast.dismiss(key);
        prompts.delete(key);
      }
    };
  }, [navigate, projectId, language, eligible, candidates]);
}

function Suggestion({
  projectId,
  language,
  candidates,
  dismiss,
  alternatives,
}: {
  projectId: number;
  language: string;
  candidates: Candidate[];
  dismiss: () => void;
  alternatives: () => void;
}) {
  const { t } = useUiTranslation();
  const marketplace = useLspMarketplace();
  const [selected, setSelected] = useState("");
  const candidate =
    candidates.length === 1 ? candidates[0] : candidates.find((entry) => entry.lsp_id === selected);
  const { ignore, isLoading } = useIgnoreSuggestion(projectId, language, dismiss);
  const mutation = marketplace.mutation;
  const error = mutation.error
    ? apiErrorMessage(
        mutation.error,
        t("workspace.editor.lspSuggestion.installFailed", "Installation failed"),
      )
    : null;
  return (
    <div
      className="w-[360px] space-y-3 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg"
      role="status"
    >
      <div>
        <p className="text-sm font-medium">
          {t("workspace.editor.lspSuggestion.addTools", "Add language tools for {{language}}?", {
            language,
          })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            "workspace.editor.lspSuggestion.chooseLanguageToolsForCompletionsNavigationAnd",
            "Choose language tools for completions, navigation and diagnostics.",
          )}
        </p>
      </div>
      <ServerSelect
        candidates={candidates}
        selected={selected}
        onSelect={setSelected}
        pending={mutation.isPending}
        candidate={candidate}
      />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={mutation.isPending || !candidate}
          onClick={() =>
            candidate &&
            mutation.mutate(
              { kind: "install", id: candidate.lsp_id, version: candidate.version },
              {
                onSuccess: () => {
                  dismiss();
                  toast.success(
                    translateUi(
                      "workspace.editor.lspSuggestion.installed",
                      "{{server}} installed",
                      { server: candidate.lsp_id },
                    ),
                  );
                },
              },
            )
          }
        >
          {mutation.isPending
            ? t("workspace.editor.lspSuggestion.installing", "Installing…")
            : error
              ? t("workspace.editor.lspSuggestion.retryInstall", "Retry install")
              : t("workspace.editor.lspSuggestion.install", "Install")}
        </Button>
        <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={alternatives}>
          {t("workspace.editor.lspSuggestion.alternatives", "Alternatives")}
        </Button>
        <IgnoreButton ignore={ignore} disabled={mutation.isPending || isLoading} />
      </div>
    </div>
  );
}

function IgnoreButton({ ignore, disabled }: { ignore: () => Promise<void>; disabled: boolean }) {
  const { t } = useUiTranslation();
  const mutation = useMutation({ mutationFn: ignore });
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={disabled || mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      {mutation.isPending
        ? t("workspace.editor.lspSuggestion.saving", "Saving…")
        : t("workspace.editor.lspSuggestion.ignore", "Ignore for project")}
    </Button>
  );
}

function useIgnoreSuggestion(projectId: number, language: string, dismiss: () => void) {
  const settings = useGetProjectSettings(projectId);
  const client = useQueryClient();
  const ignore = async () => {
    try {
      if (!settings.data)
        throw new Error(
          translateUi(
            "workspace.editor.lspSuggestion.settingsPending",
            "Project settings are still loading. Try again.",
          ),
        );
      const raw = settings.data.find(
        (entry) => entry.key === "editor_lsp_ignored_languages",
      )?.value;
      const current = raw ? ignoredSchema.parse(JSON.parse(raw) as unknown) : [];
      await setProjectSetting(projectId, {
        key: "editor_lsp_ignored_languages",
        value: JSON.stringify([...new Set([...current, language])]),
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: getGetProjectSettingsQueryKey(projectId) }),
        client.invalidateQueries({ queryKey: ["/api/lsp/resolve"] }),
      ]);
      dismiss();
    } catch (error) {
      toast.error(
        apiErrorMessage(
          error,
          translateUi(
            "workspace.editor.lspSuggestion.ignoreFailed",
            "Could not ignore language server suggestion",
          ),
        ),
      );
    }
  };
  return { ignore, isLoading: settings.isPending };
}

function ServerSelect({
  candidates,
  selected,
  onSelect,
  pending,
  candidate,
}: {
  candidates: Candidate[];
  selected: string;
  onSelect: (value: string) => void;
  pending: boolean;
  candidate: Candidate | undefined;
}) {
  const { t } = useUiTranslation();
  return (
    <>
      {candidates.length > 1 ? (
        <Select value={selected} onValueChange={onSelect} disabled={pending}>
          <SelectTrigger
            size="sm"
            aria-label={t(
              "workspace.editor.lspSuggestion.languageServerToInstall",
              "Language server to install",
            )}
          >
            <SelectValue
              placeholder={t(
                "workspace.editor.lspSuggestion.chooseALanguageServer",
                "Choose a language server",
              )}
            />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((entry) => (
              <SelectItem key={entry.lsp_id} value={entry.lsp_id}>
                {entry.lsp_id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="text-xs">{candidate?.lsp_id}</p>
      )}
    </>
  );
}

import { translateUi, UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { FolderOpen, Loader2, RefreshCw, X } from "lucide-react";
import { useScanProjectIcons, type ProjectIconCandidate } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { ProjectBadge } from "@/components/ProjectBadge";
import { ProjectIconCandidateGrid } from "@/components/settings/ProjectIconCandidateGrid";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import { apiErrorMessage } from "@/lib/api-errors";
import { PROJECT_ICON_SETTING_KEY } from "@/lib/project-icon";

function ProjectIconScanResult({
  candidates,
  error,
  isFetching,
  projectId,
  selectedPath,
  onSelect,
}: {
  candidates: ProjectIconCandidate[] | undefined;
  error: unknown;
  isFetching: boolean;
  projectId: number;
  selectedPath: string;
  onSelect: (path: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  if (isFetching) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t("project.iconField.scanningRepositoryForLogos", "Scanning repository for logos…")}
      </div>
    );
  }
  if (candidates && candidates.length > 0) {
    return (
      <ProjectIconCandidateGrid
        projectId={projectId}
        candidates={candidates}
        selectedPath={selectedPath}
        onSelect={onSelect}
      />
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {error
        ? t(
            "project.iconField.scanErrorHint",
            "The scan failed — check that this project is a git repository.",
          )
        : t(
            "project.iconField.noCandidates",
            "No logo files found in this repository. Pick one manually instead.",
          )}
    </p>
  );
}

function useProjectIconScanError(error: unknown, projectId: number): void {
  useEffect(() => {
    if (!error) return;
    toast.error(
      apiErrorMessage(
        error,
        translateUi("project.iconField.scanFailed", "Could not scan this project for logos"),
      ),
      {
        id: `project-icon-scan:${projectId}`,
      },
    );
  }, [error, projectId]);
}

function usePickProjectIcon(
  onSave: (key: typeof PROJECT_ICON_SETTING_KEY, value: string) => void,
): () => Promise<void> {
  return useCallback(async (): Promise<void> => {
    try {
      const picked = await desktopBridge.pickImageFile();
      if (picked) onSave(PROJECT_ICON_SETTING_KEY, picked);
    } catch (err) {
      toast.error(
        apiErrorMessage(
          err,
          translateUi("project.iconField.pickerFailed", "Could not open the file picker"),
        ),
      );
    }
  }, [onSave]);
}

/**
 * Lets a project show its own logo instead of the accent dot.
 *
 * On mount it scans the repository's git-tracked files for plausible logos and
 * presents them ranked; the scan is re-runnable at any time and the user can
 * always point at a file themselves via the native dialog. Shared by the
 * Project Settings dialog and the new-project onboarding modal, so both stay in
 * lockstep — the caller owns the surrounding chrome and persistence.
 */
export function ProjectIconField({
  projectId,
  iconPath,
  onSave,
}: {
  projectId: number;
  iconPath: string | undefined;
  onSave: (key: typeof PROJECT_ICON_SETTING_KEY, value: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const selectedPath = iconPath ?? "";

  const {
    data: candidates,
    isFetching,
    error,
    refetch,
  } = useScanProjectIcons(projectId, {
    query: { staleTime: Infinity, refetchOnWindowFocus: false, retry: false },
  });

  useProjectIconScanError(error, projectId);

  const handlePickFile = usePickProjectIcon(onSave);

  const handleSelect = useCallback(
    (path: string): void => {
      // Clicking the current icon again clears it, so the tile doubles as a toggle.
      onSave(PROJECT_ICON_SETTING_KEY, path === selectedPath ? "" : path);
    },
    [onSave, selectedPath],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium">
            {t("project.iconField.projectIcon", "Project icon")}
          </div>
          <p className="text-xs text-muted-foreground">
            {t(
              "project.iconField.description",
              "Show a logo from this repository instead of the color dot.",
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ProjectBadge projectId={projectId} size="md" />
          {selectedPath ? (
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("project.iconField.removeIconHint", "Remove icon and use the color dot")}
              aria-label={t("project.iconField.removeIcon", "Remove icon")}
              onClick={() => onSave(PROJECT_ICON_SETTING_KEY, "")}
            >
              <X className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {selectedPath ? (
        <p className="truncate text-xs text-muted-foreground" title={selectedPath}>
          <UiTrans
            i18nKey="project.iconField.usingPath"
            defaults="Using <path>{{path}}</path>"
            components={{ path: <span className="font-mono" /> }}
            values={{ path: selectedPath }}
          />
        </p>
      ) : null}

      <ProjectIconScanResult
        candidates={candidates}
        error={error}
        isFetching={isFetching}
        projectId={projectId}
        selectedPath={selectedPath}
        onSelect={handleSelect}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
          {candidates
            ? t("project.iconField.rescan", "Rescan")
            : t("project.iconField.scanForLogos", "Scan for logos")}
        </Button>
        {isDesktopShell() ? (
          <Button variant="ghost" size="sm" onClick={() => void handlePickFile()}>
            <FolderOpen className="size-3.5" aria-hidden />
            {t("project.iconField.chooseFile", "Choose file…")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

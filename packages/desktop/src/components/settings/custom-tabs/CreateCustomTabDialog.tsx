import { translateUi, UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useId, useState, type FormEvent } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { setFeatureSetting, usePluginTabAuthoring, type PluginTabWorkspace } from "@/api/generated";
import { useDialogSubmitShortcut } from "@/components/git-actions/useDialogSubmitShortcut";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BLOCKING_BANNER_CLASS } from "@/components/settings/SettingsWarningsBanner";
import { apiErrorCode, apiErrorMessage, toastError } from "@/lib/api-errors";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { goToCustomTabWorkspace } from "./useOpenCustomTabProject";
import {
  flatLayoutState,
  LAYOUT_STATE_KEY,
  pluginTabKind,
  serializeCurrentLayoutState,
} from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore, withTabAdded } from "@/stores/feature-layout-store";

/** The manifest bounds (`docs/CUSTOM_TABS.md` §3) the service checks the request against. */
export const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 280;

/**
 * A brand-new conversation has no saved layout yet: seed it with the tab
 * (behind the agent) so the author sees it come alive as it is built. The
 * persistence hook takes the layout it first sees as already saved, so the
 * layout is saved first and only reaches the store once the backend has it;
 * a failed save leaves the conversation on its saved layout, without the tab.
 */
async function seedStarterLayout(opened: PluginTabWorkspace): Promise<void> {
  const tab = pluginTabKind(opened.plugin_id);
  const current = useFeatureLayoutStore.getState().features[opened.feature_id];
  const layout = withTabAdded(current ?? flatLayoutState(), tab, { activate: false });
  try {
    await setFeatureSetting(opened.feature_id, {
      key: LAYOUT_STATE_KEY,
      value: serializeCurrentLayoutState(layout),
    });
  } catch (error: unknown) {
    toast.error(
      translateUi(
        "customTabs.createCustomTabDialog.placementError",
        "Could not save the new tab's placement: {{error}}",
        { error: apiErrorMessage(error, translateUi("common.unknownError", "Unknown error")) },
      ),
    );
    return;
  }
  useFeatureLayoutStore.getState().addTab(opened.feature_id, tab, { activate: false });
}

function reportProjectSetupError(caught: unknown, queryClient: QueryClient): void {
  const message = apiErrorMessage(
    caught,
    translateUi("customTabs.createCustomTabDialog.createError", "Could not create the custom tab"),
  );
  toast.error(message, {
    description: translateUi(
      "customTabs.createCustomTabDialog.retrySetupHint",
      "Use “Retry setup” on the tab's card in Settings → Custom tabs.",
    ),
  });
  invalidateByUrlPrefix(queryClient, "/api/plugin-tabs").catch((error: unknown) =>
    toastError(error, translateUi("customTabs.refreshError", "Could not refresh the custom tabs")),
  );
}

/**
 * Name a new custom tab. The service scaffolds a starter tab in its own Git
 * folder, makes it a project with a conversation, consents and enables it
 * there — so the user lands next to an agent ready to build it.
 */
export function CreateCustomTabDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useUiTranslation();
  const nameId = useId();
  const descriptionId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const authoring = usePluginTabAuthoring();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<{ cause: unknown } | null>(null);
  // The dialog stays busy until the new tab's placement is saved too.
  const [placing, setPlacing] = useState(false);
  const cleanName = name.trim();
  const busy = authoring.isPending || placing;
  const incomplete = cleanName.length === 0;
  const createTab = authoring.mutateAsync;

  const finish = useCallback(
    async (opened: PluginTabWorkspace): Promise<void> => {
      setPlacing(true);
      await seedStarterLayout(opened);
      onClose();
      toast.success(translateUi("customTabs.createCustomTabDialog.created", "Custom tab created"), {
        description: translateUi(
          "customTabs.createCustomTabDialog.createdDescription",
          "Tell the agent what the tab should show. It builds the tab with you.",
        ),
      });
      goToCustomTabWorkspace(navigate, queryClient, opened);
    },
    [navigate, onClose, queryClient],
  );

  const fail = useCallback(
    (caught: unknown): void => {
      if (apiErrorCode(caught) !== "PLUGIN_TAB_PROJECT_SETUP_FAILED") {
        setError({ cause: caught });
        return;
      }
      // The tab's folder exists; only its project is missing. Its card (shown
      // once the list refreshes) offers "Retry setup", which finishes it.
      onClose();
      reportProjectSetupError(caught, queryClient);
    },
    [onClose, queryClient],
  );

  const create = useCallback((): void => {
    if (incomplete || busy) return;
    setError(null);
    const clean = description.trim();
    createTab({ data: { name: cleanName, ...(clean ? { description: clean } : {}) } })
      .then(finish)
      .catch(fail);
  }, [busy, cleanName, createTab, description, fail, finish, incomplete]);

  useDialogSubmitShortcut({ open: true, enabled: !incomplete && !busy, onSubmit: create });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    create();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-semibold">
            {t("customTabs.createCustomTabDialog.createCustomTab", "Create custom tab")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "customTabs.createCustomTabDialog.aCustomTabIsASmallWeb",
              "A custom tab is a small web app shown beside Agent, Terminal and Git. Name it and Cadencr sets up everything to build it with an agent.",
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5 px-6 py-5" noValidate>
          <NameAndDescription
            ids={{ name: nameId, description: descriptionId }}
            name={name}
            description={description}
            disabled={busy}
            onName={setName}
            onDescription={setDescription}
          />
          <CreatedSummary />
          {error ? (
            <CreateErrorAlert
              message={apiErrorMessage(
                error.cause,
                t(
                  "customTabs.createCustomTabDialog.createError",
                  "Could not create the custom tab",
                ),
              )}
            />
          ) : null}
          <CreateControls busy={busy} disabled={incomplete || busy} onClose={onClose} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateControls({
  busy,
  disabled,
  onClose,
}: {
  busy: boolean;
  disabled: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          {t("common.cancel", "Cancel")}
        </Button>
        <Button type="submit" disabled={disabled}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {busy
            ? t("customTabs.createCustomTabDialog.creating", "Creating…")
            : t("customTabs.createCustomTabDialog.createCustomTab", "Create custom tab")}
        </Button>
      </DialogFooter>
      <p aria-live="polite" className="sr-only">
        {busy
          ? t(
              "customTabs.createCustomTabDialog.creatingStatus",
              "Creating the custom tab and opening its conversation.",
            )
          : ""}
      </p>
    </>
  );
}

function NameAndDescription({
  ids,
  name,
  description,
  disabled,
  onName,
  onDescription,
}: {
  ids: { name: string; description: string };
  name: string;
  description: string;
  disabled: boolean;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor={ids.name} className="text-xs font-medium">
          {t("customTabs.createCustomTabDialog.name", "Name")}
        </label>
        <Input
          id={ids.name}
          autoFocus
          required
          value={name}
          onChange={(event) => onName(event.target.value)}
          placeholder={t(
            "customTabs.createCustomTabDialog.changedFilesGraph",
            "Changed files graph",
          )}
          maxLength={MAX_NAME_LENGTH}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={ids.description} className="text-xs font-medium">
            {t("customTabs.createCustomTabDialog.description", "Description")}{" "}
            <span className="font-normal text-muted-foreground">
              {t("customTabs.createCustomTabDialog.optional", "(optional)")}
            </span>
          </label>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {description.length}/{MAX_DESCRIPTION_LENGTH}
          </span>
        </div>
        <Textarea
          id={ids.description}
          value={description}
          onChange={(event) => onDescription(event.target.value)}
          placeholder={t(
            "customTabs.createCustomTabDialog.whatTheTabShowsInOneSentence",
            "What the tab shows, in one sentence.",
          )}
          maxLength={MAX_DESCRIPTION_LENGTH}
          rows={2}
          disabled={disabled}
          className="resize-none"
        />
      </div>
    </div>
  );
}

function CreatedSummary(): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">
        {t("customTabs.createCustomTabDialog.cadencrCreates", "Cadencr creates:")}
      </p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4">
        <li>
          <UiTrans
            i18nKey="customTabs.createCustomTabDialog.starterFolder"
            defaults="a starter tab (Vite, React and the Cadencr tab kit) in its own Git folder under the <path/> folder of Cadencr's app data;"
            components={{ path: <span className="font-mono">plugins/tabs</span> }}
          />
        </li>
        <li>
          {t(
            "customTabs.createCustomTabDialog.aProjectForItWithAnAgent",
            "a project for it with an agent conversation, ready to build the tab;",
          )}
        </li>
        <li>
          {t(
            "customTabs.createCustomTabDialog.theTabSwitchedOnInThatProject",
            "the tab, switched on in that project so you see it change as it is built.",
          )}
        </li>
      </ul>
    </div>
  );
}

function CreateErrorAlert({ message }: { message: string }): React.JSX.Element {
  return (
    <div role="alert" className={cn(BLOCKING_BANNER_CLASS, "flex items-start gap-2 text-xs")}>
      <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-[var(--acc-red)]" aria-hidden />
      <p className="min-w-0 flex-1 break-words">{message}</p>
    </div>
  );
}

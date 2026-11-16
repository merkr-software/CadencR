import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getPluginTabGetQueryOptions,
  usePluginTabConsent,
  usePluginTabSetEnablement,
  type PluginTabPendingUpdate,
  type PluginTabSummary,
} from "@/api/generated";
import { apiErrorCode, apiErrorMessage, toastError } from "@/lib/api-errors";
import { PLUGIN_TAB_ERROR } from "@/lib/plugin-tabs/error-codes";
import { refreshPluginTabReads } from "@/lib/plugin-tabs/live-instances";
import type { ProjectOverride } from "./custom-tab-model";

/** A consent the user is being asked for, and the switch it unlocks. */
export interface ConsentRequest {
  tab: PluginTabSummary;
  /** The switch turned on once consent is recorded; `null` = consent only. */
  enable: { projectId: number | null } | null;
  /** The manifest (or the staged update) changed while the previous dialog was open. */
  stale: boolean;
  /**
   * A staged marketplace update under review: the dialog shows what it would
   * run, and accepting it records its hash, which makes it the installed one.
   */
  update: PluginTabPendingUpdate | null;
}

export interface CustomTabEnablement {
  /** Flip the global switch (`projectId = null`) or a project override (`null` = inherit). */
  change: (tab: PluginTabSummary, projectId: number | null, enabled: ProjectOverride) => void;
  /** Ask for consent without changing a switch (a tab whose permissions widened). */
  review: (tab: PluginTabSummary) => void;
  /** Review the marketplace update staged for this tab (`tab.pending_update`). */
  reviewUpdate: (tab: PluginTabSummary) => void;
  request: ConsentRequest | null;
  /** Record consent; `trustsCode` = the user ticked "I trust this code" (commands, native code). */
  accept: (trustsCode: boolean) => void;
  cancel: () => void;
  accepting: boolean;
  /** `<tab id>:<project id | "global">` of the switch being written. */
  pendingKey: string | null;
}

export function enablementKey(tabId: string, projectId: number | null): string {
  return `${tabId}:${projectId ?? "global"}`;
}

/** The answers that mean "what you reviewed is no longer what would be recorded". */
const STALE_CODES: ReadonlySet<string> = new Set([
  PLUGIN_TAB_ERROR.consentStale,
  PLUGIN_TAB_ERROR.updateChanged,
]);

interface ReopenOptions {
  /** The switch the consent unlocks (`ConsentRequest.enable`). */
  enable: ConsentRequest["enable"];
  /** What the user reviewed changed meanwhile: the dialog says so. */
  stale: boolean;
  /** Reopen on the staged update rather than the installed version. */
  update: boolean;
}

/**
 * The tab's summary, refetched: the dialog then shows what the service would
 * record now. An update that is no longer staged closes the dialog and says so.
 */
function useReopen(setRequest: (request: ConsentRequest | null) => void) {
  const queryClient = useQueryClient();
  return useCallback(
    async (tabId: string, { enable, stale, update }: ReopenOptions): Promise<void> => {
      try {
        const fresh = await queryClient.fetchQuery({
          ...getPluginTabGetQueryOptions(tabId),
          staleTime: 0,
        });
        if (update && !fresh.pending_update) {
          setRequest(null);
          toast.info(`The update to “${fresh.name}” is no longer waiting for review.`);
          return;
        }
        setRequest({
          tab: fresh,
          enable,
          stale,
          update: update ? (fresh.pending_update ?? null) : null,
        });
      } catch (error: unknown) {
        setRequest(null);
        toastError(error, "Could not reload the custom tab's permissions");
      }
    },
    [queryClient, setRequest],
  );
}

/** Refetches every custom tab view: the local list, and the marketplace inventory. */
async function refresh(): Promise<void> {
  try {
    await refreshPluginTabReads();
  } catch (error: unknown) {
    toastError(error, "Could not refresh the custom tabs");
  }
}

/**
 * Switching a tab on is gated by consent (`docs/CUSTOM_TABS.md` §4.2): the
 * dialog comes first whenever the tab has no consent at its current
 * permissions hash, and only an accepted consent is followed by the switch.
 * A manifest that widened in the meantime makes the service refuse the
 * consent (`PLUGIN_TAB_CONSENT_STALE`); the dialog then shows the fresh
 * permissions instead of silently enabling what the user never saw. A
 * staged marketplace update is accepted the same way, at its own hash.
 */
export function useCustomTabEnablement(): CustomTabEnablement {
  const setEnablement = usePluginTabSetEnablement();
  const consent = usePluginTabConsent();
  const [request, setRequest] = useState<ConsentRequest | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const putEnablement = setEnablement.mutateAsync;
  const putConsent = consent.mutateAsync;
  const reopen = useReopen(setRequest);

  const put = useCallback(
    async (tab: PluginTabSummary, projectId: number | null, enabled: ProjectOverride) => {
      setPendingKey(enablementKey(tab.id, projectId));
      try {
        await putEnablement({ id: tab.id, data: { project_id: projectId, enabled } });
      } catch (error: unknown) {
        // The list was older than the consent table: ask now, then retry.
        if (apiErrorCode(error) === PLUGIN_TAB_ERROR.consentRequired) {
          await reopen(tab.id, { enable: { projectId }, stale: false, update: false });
        } else {
          toastError(error, `Could not change where “${tab.name}” is on`);
        }
      } finally {
        setPendingKey(null);
        await refresh();
      }
    },
    [putEnablement, reopen],
  );

  const change = useCallback(
    (tab: PluginTabSummary, projectId: number | null, enabled: ProjectOverride): void => {
      if (enabled === true && tab.enablement.consent_required) {
        setRequest({ tab, enable: { projectId }, stale: false, update: null });
        return;
      }
      void put(tab, projectId, enabled);
    },
    [put],
  );

  const accept = useCallback(
    (trustsCode: boolean): void => {
      if (!request) return;
      const { tab, enable, update } = request;
      const hash = update ? update.permissions_hash : (tab.permissions_hash ?? "");
      putConsent({ id: tab.id, data: { permissions_hash: hash, trusts_code: trustsCode } })
        .then(async () => {
          setRequest(null);
          if (enable) await put(tab, enable.projectId, true);
          else await refresh();
        })
        .catch(async (error: unknown) => {
          const code = apiErrorCode(error) ?? "";
          if (STALE_CODES.has(code)) {
            await reopen(tab.id, { enable, stale: true, update: update !== null });
            return;
          }
          if (code === PLUGIN_TAB_ERROR.blocked) {
            // Nothing to allow any more: the version is on the revocation list.
            setRequest(null);
            toast.error(`“${tab.name}” is blocked by Cadencr`, {
              description: apiErrorMessage(error, "This version is on the revocation list."),
            });
            await refresh();
            return;
          }
          toastError(error, `Could not record your consent for “${tab.name}”`);
        });
    },
    [put, putConsent, reopen, request],
  );

  const review = useCallback((tab: PluginTabSummary): void => {
    setRequest({ tab, enable: null, stale: false, update: null });
  }, []);
  const reviewUpdate = useCallback((tab: PluginTabSummary): void => {
    if (tab.pending_update)
      setRequest({ tab, enable: null, stale: false, update: tab.pending_update });
  }, []);
  const cancel = useCallback((): void => setRequest(null), []);
  const accepting = consent.isPending || (request !== null && setEnablement.isPending);

  return useMemo(
    () => ({ change, review, reviewUpdate, request, accept, cancel, accepting, pendingKey }),
    [accept, accepting, cancel, change, pendingKey, request, review, reviewUpdate],
  );
}

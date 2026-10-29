import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  useGetCustomActionRuns,
  useGetCustomActionVariables,
  type CustomAction,
} from "@/api/generated";

export interface CustomActionVariableDrafts {
  /** The value to show in a variable's field: the user's edit, else the stored value. */
  valueOf: (name: string) => string;
  /** Record a user edit for a variable. */
  setDraft: (name: string, value: string) => void;
  /** True when the user's edit differs from the stored value. */
  isDirty: (name: string) => boolean;
}

/**
 * Per-feature variable values for an action. Only fields the user has edited
 * carry a draft; every other field reads the stored value directly, so a value
 * that loads after the panel mounts is never masked by an empty placeholder
 * (and an untouched field is never saved back as "").
 */
export function useCustomActionVariableDrafts(
  actionId: number,
  featureId: number,
): CustomActionVariableDrafts {
  const { data: storedVars } = useGetCustomActionVariables(actionId, { feature_id: featureId });
  const stored = useMemo(
    () => new Map((storedVars ?? []).map((variable) => [variable.var_name, variable.value])),
    [storedVars],
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const valueOf = useCallback(
    (name: string): string => drafts[name] ?? stored.get(name) ?? "",
    [drafts, stored],
  );
  const setDraft = useCallback((name: string, value: string): void => {
    setDrafts((previous) => ({ ...previous, [name]: value }));
  }, []);
  const isDirty = useCallback(
    (name: string): boolean =>
      drafts[name] !== undefined && drafts[name] !== (stored.get(name) ?? ""),
    [drafts, stored],
  );
  return useMemo(() => ({ valueOf, setDraft, isDirty }), [valueOf, setDraft, isDirty]);
}

/**
 * The action's recent runs for this feature. Polls while the latest run is in
 * flight, and refetches whenever the action's `last_run` summary (kept live by
 * the bar's list query) changes — so a run started elsewhere (a schedule, the
 * API, another surface) shows up instead of a cached "No runs yet".
 */
export function useCustomActionRuns(action: CustomAction, featureId: number) {
  const runsQuery = useGetCustomActionRuns(
    action.id,
    { feature_id: featureId, limit: 5 },
    {
      query: {
        refetchOnMount: "always",
        refetchInterval: (query) => {
          const latestRun = query.state.data?.[0];
          return latestRun != null && latestRun.ended_at == null ? 2000 : false;
        },
      },
    },
  );
  const lastRunKey = `${action.last_run?.ended_at ?? "running"}|${action.last_run?.exit_code ?? ""}|${action.last_run == null}`;
  const { refetch } = runsQuery;
  // The mount fetch is covered by `refetchOnMount`; only react to later changes.
  const seenKey = useRef(lastRunKey);
  useEffect(() => {
    if (seenKey.current === lastRunKey) return;
    seenKey.current = lastRunKey;
    void refetch();
  }, [lastRunKey, refetch]);
  return runsQuery;
}

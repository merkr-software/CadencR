import { useUiTranslation, translateUi, type UiTranslator } from "@/lib/i18n/ui";
import { useCallback, useMemo } from "react";
import { create } from "zustand";
import type { StashMutationOperation } from "./stash-contracts";

export type StashMutationOwner =
  | { kind: "push" }
  | { kind: "row"; operation: StashMutationOperation; stashRefName: string };

export interface StashMutationLease {
  featureId: number;
  id: number;
  owner: StashMutationOwner;
}

interface StashMutationStore {
  activeByFeature: Record<number, StashMutationLease | undefined>;
  tryAcquire: (featureId: number, owner: StashMutationOwner) => StashMutationLease | null;
  release: (lease: StashMutationLease) => void;
}

let nextLeaseId = 1;

const useStashMutationStore = create<StashMutationStore>((set) => ({
  activeByFeature: {},
  tryAcquire: (featureId, owner) => {
    let acquired: StashMutationLease | null = null;
    set((state) => {
      if (state.activeByFeature[featureId]) return state;
      acquired = { featureId, id: nextLeaseId++, owner };
      return {
        activeByFeature: { ...state.activeByFeature, [featureId]: acquired },
      };
    });
    return acquired;
  },
  release: (lease) =>
    set((state) => {
      if (state.activeByFeature[lease.featureId]?.id !== lease.id) return state;
      const activeByFeature = { ...state.activeByFeature };
      delete activeByFeature[lease.featureId];
      return { activeByFeature };
    }),
}));

export interface StashMutationCoordinator {
  activeMutation: StashMutationOwner | null;
  blockedReason: string | null;
  getBlockedReason: () => string | null;
  tryAcquire: (owner: StashMutationOwner) => StashMutationLease | null;
  release: (lease: StashMutationLease) => void;
}

export function stashMutationBlockedReason(
  owner: StashMutationOwner | null,
  t: UiTranslator = translateUi,
): string | null {
  if (!owner) return null;
  if (owner.kind === "push")
    return t(
      "workspace.git.useStashMutationCoordinator.pushPending",
      "Stash changes request in progress",
    );
  return stashRefPendingLabel(owner.operation, owner.stashRefName, t);
}

export function stashRefPendingLabel(
  operation: StashMutationOperation,
  ref: string,
  t: UiTranslator,
): string {
  switch (operation) {
    case "apply":
      return t(
        "workspace.git.useStashMutationCoordinator.applyPending",
        "Apply {{ref}} in progress",
        { ref },
      );
    case "pop":
      return t("workspace.git.useStashMutationCoordinator.popPending", "Pop {{ref}} in progress", {
        ref,
      });
    case "drop":
      return t(
        "workspace.git.useStashMutationCoordinator.dropPending",
        "Drop {{ref}} in progress",
        { ref },
      );
  }
}

/**
 * Feature-keyed single-flight lease shared by the header dialog and stash rows.
 * Zustand's synchronous `set` callback makes acquisition atomic before React
 * can render a disabled state, so same-tick dispatches cannot race through.
 */
export function useStashMutationCoordinator(featureId: number): StashMutationCoordinator {
  const { t } = useUiTranslation();
  const activeLease = useStashMutationStore((state) => state.activeByFeature[featureId]);
  const activeMutation = activeLease?.owner ?? null;
  const blockedReason = stashMutationBlockedReason(activeMutation, t);

  const getBlockedReason = useCallback(
    (): string | null =>
      stashMutationBlockedReason(
        useStashMutationStore.getState().activeByFeature[featureId]?.owner ?? null,
      ),
    [featureId],
  );
  const tryAcquire = useCallback(
    (owner: StashMutationOwner): StashMutationLease | null =>
      useStashMutationStore.getState().tryAcquire(featureId, owner),
    [featureId],
  );
  const release = useCallback(
    (lease: StashMutationLease): void => useStashMutationStore.getState().release(lease),
    [],
  );

  return useMemo(
    () => ({ activeMutation, blockedReason, getBlockedReason, tryAcquire, release }),
    [activeMutation, blockedReason, getBlockedReason, release, tryAcquire],
  );
}

export function resetStashMutationCoordinatorForTest(): void {
  useStashMutationStore.setState({ activeByFeature: {} });
}

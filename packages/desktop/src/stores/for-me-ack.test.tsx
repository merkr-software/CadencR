// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGetWorkspaceSettingQueryKey, type PrStatusSnapshot } from "@/api/generated";
import { deriveNextActions } from "@/lib/next-actions";
import { queryClient } from "@/lib/queryClient";
import { acknowledgeForMe, openingClearsForMe, useMarkFeatureRead } from "@/stores/for-me-ack";
import { useUnreadStore } from "@/stores/unread-store";
import { usePrStatusStore } from "@/stores/usePrStatusStore";

const ACK_KEY = getGetWorkspaceSettingQueryKey("sidebar_for_me_ack");

function seedAckSetting(value: string | null): void {
  queryClient.setQueryData(ACK_KEY, { value });
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function openConversation(featureId: number) {
  return renderHook(({ id }) => useMarkFeatureRead(id), {
    initialProps: { id: featureId },
    wrapper,
  });
}

function failingPr(featureId: number, headSha: string): PrStatusSnapshot {
  return {
    feature_id: featureId,
    fetched_at: 1,
    setup_required: false,
    error: null,
    ci: { state: "failing", checks: [] },
    pr: {
      number: 40 + featureId,
      title: "PR",
      body_markdown: "",
      state: "open",
      url: "https://forge.test/pr",
      source_branch: "b",
      target_branch: "main",
      head_sha: headSha,
      review_state: "none",
      author: { username: "me", display_name: null, avatar_url: null },
      updated_at: "2026-10-01T00:00:00Z",
      pr_label: "Pull request",
    },
  };
}

beforeEach(() => {
  useUnreadStore.setState({ byFeature: {}, failedByFeature: {}, markedOrder: {}, prAcks: {} });
  usePrStatusStore.setState({ byFeature: {}, latestFetchedAtByFeature: {} });
});

afterEach(() => {
  queryClient.clear();
});

describe("useMarkFeatureRead", () => {
  it("reads the conversation when it opens, For me clearing on open", () => {
    seedAckSetting(null);
    useUnreadStore.getState().markUnread(7);
    useUnreadStore.getState().markFailed(8);
    openConversation(7);
    openConversation(8);
    expect(useUnreadStore.getState().byFeature[7]).toBeUndefined();
    expect(useUnreadStore.getState().failedByFeature[8]).toBeUndefined();
  });

  it("waits for the setting, so a restart in When done reads nothing", () => {
    useUnreadStore.getState().markUnread(7);
    openConversation(7);
    expect(useUnreadStore.getState().byFeature[7]).toBe(true);
    act(() => seedAckSetting("manual"));
    expect(useUnreadStore.getState().byFeature[7]).toBe(true);
  });

  it("keeps the entry while open when For me clears only when done", () => {
    seedAckSetting("manual");
    useUnreadStore.getState().markUnread(7);
    openConversation(7);
    expect(useUnreadStore.getState().byFeature[7]).toBe(true);
  });

  it("lets a hand-marked unread survive while its conversation stays open", () => {
    seedAckSetting(null);
    const { rerender } = openConversation(7);
    act(() => useUnreadStore.getState().markUnread(7));
    rerender({ id: 7 });
    expect(useUnreadStore.getState().byFeature[7]).toBe(true);
  });
});

describe("openingClearsForMe", () => {
  it("follows the setting, the default until it loads", () => {
    expect(openingClearsForMe()).toBe(true);
    seedAckSetting("manual");
    expect(openingClearsForMe()).toBe(false);
    seedAckSetting("bogus");
    expect(openingClearsForMe()).toBe(true);
  });
});

describe("acknowledgeForMe", () => {
  it("reads the conversation and dismisses its pull request action until the PR moves", () => {
    usePrStatusStore.getState().hydrate([failingPr(3, "aaa")]);
    useUnreadStore.getState().markUnread(3);
    acknowledgeForMe(3);

    const { byFeature, prAcks } = useUnreadStore.getState();
    expect(byFeature[3]).toBeUndefined();
    const prs = usePrStatusStore.getState().byFeature;
    expect(deriveNextActions([], prs, prAcks)).toEqual([]);

    // A push brings the failing checks back as a new action.
    usePrStatusStore.getState().setStatus({ ...failingPr(3, "bbb"), fetched_at: 2 });
    expect(deriveNextActions([], usePrStatusStore.getState().byFeature, prAcks)).toEqual([
      { featureId: 3, kind: "fix_ci" },
    ]);
  });

  it("only reads a conversation whose pull request asks nothing", () => {
    useUnreadStore.getState().markFailed(5);
    acknowledgeForMe(5);
    expect(useUnreadStore.getState()).toMatchObject({ failedByFeature: {}, prAcks: {} });
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type PublicationReleasePreview,
  getGetPublicationOperationQueryKey,
  getListPublicationOperationsQueryKey,
} from "@/api/generated";
import { publicationBundles, useRefreshPublicationJournal } from "./PublicationRequest";

describe("publication request reuse", () => {
  it("preserves platform order and omits the primary bundle from additional IDs", () => {
    const preview = {
      bundle_id: "primary",
      archives: [{ bundle_id: "linux" }, { bundle_id: "primary" }, { bundle_id: "windows" }],
    } as PublicationReleasePreview;
    expect(publicationBundles(preview)).toEqual({
      bundle_id: "primary",
      bundle_ids: ["linux", "windows"],
    });
  });
  it("invalidates every journal page and focused record only for this project", async () => {
    const client = new QueryClient();
    const keys = [
      getListPublicationOperationsQueryKey(1),
      getListPublicationOperationsQueryKey(1, { limit: 20, cursor: "a".repeat(64) }),
      getGetPublicationOperationQueryKey(1, "a".repeat(64)),
      getListPublicationOperationsQueryKey(2),
    ];
    for (const key of keys) client.setQueryData(key, {});
    const hook = renderHook(() => useRefreshPublicationJournal(1), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await act(async () => hook.result.current());
    expect(keys.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    hook.unmount();
    client.clear();
  });
});

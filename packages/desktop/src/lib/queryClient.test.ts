import { describe, it, expect } from "vitest";
import { QueryClient, type Query } from "@tanstack/react-query";
import { invalidateByUrlPrefix, urlPrefixPredicate } from "./queryClient";

/**
 * Regression test for the stale-query-key bug: invalidations were keyed under
 * ad-hoc tuples (`["features", "list"]`) while orval emits URL-keyed tuples
 * (`["/api/features", { project_id: 1 }]` and `["/api/features/123"]`). React
 * Query's array-prefix matcher cannot bridge the two flavours, so
 * `invalidateByUrlPrefix` exists to invalidate every URL-keyed query whose
 * head string starts with a given prefix.
 */
describe("invalidateByUrlPrefix", () => {
  function seed(client: QueryClient, key: readonly unknown[], value: unknown): void {
    client.setQueryData(key, value);
  }

  it("invalidates parametrised list keys, per-id detail keys, and nested URL keys", async () => {
    const client = new QueryClient();
    seed(client, ["/api/features", { project_id: 1 }], [{ id: 1 }]);
    seed(client, ["/api/features", { project_id: 2 }], [{ id: 2 }]);
    seed(client, ["/api/features/123"], { id: 123 });
    seed(client, ["/api/features/123/plan/progress"], { progress: 0 });
    // Unrelated cache entry — must remain untouched.
    seed(client, ["/api/projects"], [{ id: 9 }]);

    await invalidateByUrlPrefix(client, "/api/features");

    const cache = client.getQueryCache();
    expect(
      cache.find({ queryKey: ["/api/features", { project_id: 1 }] })?.state.isInvalidated,
    ).toBe(true);
    expect(
      cache.find({ queryKey: ["/api/features", { project_id: 2 }] })?.state.isInvalidated,
    ).toBe(true);
    expect(cache.find({ queryKey: ["/api/features/123"] })?.state.isInvalidated).toBe(true);
    expect(cache.find({ queryKey: ["/api/features/123/plan/progress"] })?.state.isInvalidated).toBe(
      true,
    );
    expect(cache.find({ queryKey: ["/api/projects"] })?.state.isInvalidated).toBe(false);
  });

  it("ignores keys whose head is not a string", async () => {
    const client = new QueryClient();
    seed(client, [{ kind: "weird" }, "/api/features"], "value");
    seed(client, ["/api/features"], "ok");

    await invalidateByUrlPrefix(client, "/api/features");

    const cache = client.getQueryCache();
    expect(
      cache.find({ queryKey: [{ kind: "weird" }, "/api/features"] })?.state.isInvalidated,
    ).toBe(false);
    expect(cache.find({ queryKey: ["/api/features"] })?.state.isInvalidated).toBe(true);
  });

  it("matches the empty-prefix edge case (would invalidate every URL key)", async () => {
    const client = new QueryClient();
    seed(client, ["/api/x"], 1);
    seed(client, ["/api/y"], 2);

    await invalidateByUrlPrefix(client, "");

    const cache = client.getQueryCache();
    expect(cache.find({ queryKey: ["/api/x"] })?.state.isInvalidated).toBe(true);
    expect(cache.find({ queryKey: ["/api/y"] })?.state.isInvalidated).toBe(true);
  });

  it("delegates matching to the shared urlPrefixPredicate", async () => {
    // `urlPrefixPredicate` backs both `invalidateByUrlPrefix` and the
    // unified-agents pin cache patch (`setQueriesData`), so its contract is
    // exercised directly here against synthetic query keys.
    const asQuery = (queryKey: readonly unknown[]): Query => ({ queryKey }) as unknown as Query;
    const match = urlPrefixPredicate("/api/features");

    expect(match(asQuery(["/api/features", { project_id: 1 }]))).toBe(true);
    expect(match(asQuery(["/api/features/123"]))).toBe(true);
    expect(match(asQuery(["/api/projects"]))).toBe(false);
    expect(match(asQuery([{ kind: "weird" }]))).toBe(false);

    const multi = urlPrefixPredicate(["/api/editor", "/api/git"]);
    expect(multi(asQuery(["/api/editor/tree"]))).toBe(true);
    expect(multi(asQuery(["/api/git/stats"]))).toBe(true);
    expect(multi(asQuery(["/api/features"]))).toBe(false);
  });

  it("accepts an array of prefixes and folds them into a single cache walk", async () => {
    const client = new QueryClient();
    seed(client, ["/api/editor/tree"], 1);
    seed(client, ["/api/editor/search", { q: "x" }], 2);
    seed(client, ["/api/git/stats"], 3);
    seed(client, ["/api/features"], 4);

    await invalidateByUrlPrefix(client, [
      "/api/editor/tree",
      "/api/editor/search",
      "/api/git/stats",
    ]);

    const cache = client.getQueryCache();
    expect(cache.find({ queryKey: ["/api/editor/tree"] })?.state.isInvalidated).toBe(true);
    expect(cache.find({ queryKey: ["/api/editor/search", { q: "x" }] })?.state.isInvalidated).toBe(
      true,
    );
    expect(cache.find({ queryKey: ["/api/git/stats"] })?.state.isInvalidated).toBe(true);
    expect(cache.find({ queryKey: ["/api/features"] })?.state.isInvalidated).toBe(false);
  });
});

describe("revalidateRestoredQueries", () => {
  it("marks restored entries stale even under staleTime: Infinity", async () => {
    const { queryClient, revalidateRestoredQueries } = await import("./queryClient");
    queryClient.setQueryData(["/api/workspace/settings/sidebar.lens"], { value: "old" });
    const query = queryClient.getQueryCache().find({
      queryKey: ["/api/workspace/settings/sidebar.lens"],
    });
    expect(query?.isStaleByTime(Infinity)).toBe(false);

    await revalidateRestoredQueries();

    expect(query?.isStaleByTime(Infinity)).toBe(true);
    expect(queryClient.getQueryData(["/api/workspace/settings/sidebar.lens"])).toEqual({
      value: "old",
    });
    queryClient.clear();
  });
});

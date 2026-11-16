import { describe, expect, it } from "vitest";
import { CadencrError } from "./errors.js";
import { getFeature, getGitStatus, listFeatures, readFile } from "./plugin-api.js";
import { connected } from "./test-utils.js";
import { jsonResponse } from "./testing/index.js";

describe("@cadencr/tab-sdk/api", () => {
  it("sends generated calls through the port with method, path and query", async () => {
    const { host, client } = await connected();
    host.route("GET", "/api/features/12", jsonResponse(200, { id: 12, title: "Graph" }));
    host.route("GET", "/api/features", (request) => jsonResponse(200, [request.query]));
    host.route("GET", "/api/editor/read", (request) =>
      jsonResponse(200, { content: request.query?.file_path ?? "" }),
    );

    await expect(getFeature(12)).resolves.toMatchObject({ id: 12, title: "Graph" });
    await expect(listFeatures({ project_id: 4, include_archived: true })).resolves.toEqual([
      { project_id: "4", include_archived: "true" },
    ]);
    await expect(
      readFile({ project_id: 4, feature_id: 12, file_path: "src/a b.ts" }),
    ).resolves.toEqual({ content: "src/a b.ts" });

    const calls = host.requests
      .filter((request) => request.method === "api.request")
      .map((request) => request.params);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/features/12", query: {} });
    expect(calls[2]).toMatchObject({
      method: "GET",
      path: "/api/editor/read",
      query: { project_id: "4", feature_id: "12", file_path: "src/a b.ts" },
    });
    client.close();
    host.close();
  });

  it("throws the service's error as CadencrError", async () => {
    const { host, client } = await connected();
    host.route(
      "GET",
      "/api/git/status",
      jsonResponse(403, { error: "requires git:read", code: "PLUGIN_SCOPE_DENIED" }),
    );
    const error = await getGitStatus({ feature_id: 12 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CadencrError);
    expect(error).toMatchObject({ code: "PLUGIN_SCOPE_DENIED", status: 403 });
    client.close();
    host.close();
  });
  it("keeps serving through the newer client when an older one closes", async () => {
    const first = await connected();
    const second = await connected();
    second.host.route("GET", "/api/features/7", jsonResponse(200, { id: 7 }));
    first.client.close();
    await expect(getFeature(7)).resolves.toMatchObject({ id: 7 });
    second.client.close();
    await expect(getFeature(7)).rejects.toMatchObject({ code: "DISCONNECTED" });
  });
});

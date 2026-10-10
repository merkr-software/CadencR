// Test-only persistent remote: both language implementations use the same fixture.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { startGitHubFixture } from "./github-server.mjs";
import { runRegistryPublisher } from "../../scripts/publish-registry.mjs";
import {
  downloadVerifiedArchive,
  downloadVerifiedDiscovery,
} from "../../scripts/publication/download.mjs";

const cleanup = [];
const { state, url } = await startGitHubFixture(
  { after: (fn) => cleanup.push(fn) },
  "handoff-token",
  {
    repository: "cadencr/registry",
    branch: "main",
    inlineAssets: true,
  },
);
state.strictTags = true;
state.sourceArchives.set(
  "/public/acme/provider/releases/download/v1/provider.tgz",
  Buffer.from("archive"),
);
const routes = {
  "github.com": "/public",
  "api.github.com": "/api",
  "uploads.github.com": "/uploads",
  "raw.githubusercontent.com": "/raw",
  "release-assets.githubusercontent.com": "/cdn",
};
async function fixtureFetch(input, options) {
  const target = new URL(input);
  if (!routes[target.hostname]) throw new Error("unknown handoff destination");
  const result = await fetch(
    url + routes[target.hostname] + target.pathname + target.search,
    options,
  );
  return new Response(result.body, { status: result.status, headers: result.headers });
}
async function control(input) {
  if (input.action === "configure") {
    state.publicUnavailable = input.publicUnavailable ?? false;
    state.rawUnavailable = input.rawUnavailable ?? false;
    if (input.retireSources) state.sourceArchives.clear();
  }
  if (input.action === "run") {
    const request = await readFile(input.request);
    try {
      await runRegistryPublisher(
        {
          request: input.request,
          directory: input.directory,
          repository: "cadencr/registry",
          "registry-commit": "b".repeat(40),
          "private-key": input.privateKey,
          "confirm-request-sha256": createHash("sha256").update(request).digest("hex"),
        },
        {
          token: "handoff-token",
          fetchImpl: fixtureFetch,
          download: (args) => downloadVerifiedArchive(args, { fetchImpl: fixtureFetch }),
          downloadDiscovery: (args) => downloadVerifiedDiscovery(args, { fetchImpl: fixtureFetch }),
        },
      );
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
  return {
    writes: state.requests.filter((entry) => entry.method !== "GET").length,
    requests: state.requests,
    releases: state.releases.length,
    releaseRecords: state.releases,
    discovery: state.discovery
      ? {
          sha: state.discovery.sha,
          sha256: createHash("sha256").update(state.discovery.bytes).digest("hex"),
        }
      : null,
  };
}
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await control(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(500);
    response.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ remote: url, control: `http://127.0.0.1:${server.address().port}` }));
const timeout = setTimeout(() => process.exit(2), 120_000);
process.once("SIGTERM", async () => {
  clearTimeout(timeout);
  server.closeAllConnections();
  server.close();
  for (const fn of cleanup) await fn();
  process.exit(0);
});

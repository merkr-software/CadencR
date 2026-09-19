import { createServer } from "node:http";

export async function startGitHubFixture(t, token) {
  const state = {
    releases: [],
    assets: [],
    requests: [],
    nextId: 1,
    nextReleaseId: 42,
    tagCommit: "b".repeat(40),
    publicUnavailable: false,
    catalogPublicUnavailable: false,
  };
  Object.defineProperty(state, "release", {
    enumerable: true,
    get() {
      return this.releases.at(-1) ?? null;
    },
  });
  const server = createServer((request, response) => {
    handle(request, response, state, token).catch((error) => {
      response.writeHead(500);
      response.end(String(error.message));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

async function handle(request, response, state, token) {
  const url = new URL(request.url, "http://fixture.invalid");
  state.requests.push({
    method: request.method,
    path: url.pathname,
    auth: request.headers.authorization,
  });
  const isCdn = url.pathname.startsWith("/cdn/");
  const isPublic = url.pathname.startsWith("/public/");
  const expectedAuth = isCdn || isPublic ? undefined : `Bearer ${token}`;
  if (request.headers.authorization !== expectedAuth) return json(response, 403, {});
  if (isPublic) return servePublicAsset(response, state, url);
  if (
    url.pathname.startsWith("/api/repos/acme/registry/git/ref/tags/") &&
    request.method === "GET"
  ) {
    return serveTag(response, state, url);
  }
  if (isCdn) return serveCdnAsset(response, state, url);
  return handleReleaseApi(request, response, state, url);
}

function servePublicAsset(response, state, url) {
  const asset = state.assets.find(
    (entry) => `/public${new URL(entry.browser_download_url).pathname}` === url.pathname,
  );
  const release = state.releases.find((entry) => entry.id === asset?.release_id);
  if (
    !asset ||
    release?.draft !== false ||
    state.publicUnavailable ||
    (state.catalogPublicUnavailable && asset.name === "managed-index.json")
  )
    return json(response, 404, {});
  response.writeHead(302, {
    location: `https://release-assets.githubusercontent.com/${asset.id}`,
  });
  response.end();
}

function serveTag(response, state, url) {
  if (!state.tagCommit) return json(response, 404, {});
  const tag = decodeURIComponent(url.pathname.split("/").at(-1));
  const release = state.releases.find((entry) => entry.tag_name === tag);
  if (!release && !/^catalog-[0-9a-f]{64}$/.test(tag)) return json(response, 404, {});
  return json(response, 200, {
    ref: `refs/tags/${tag}`,
    object: { type: "commit", sha: state.tagCommit },
  });
}

function serveCdnAsset(response, state, url) {
  const asset = state.assets.find((entry) => entry.id === Number(url.pathname.split("/").at(-1)));
  if (!asset) return json(response, 404, {});
  response.writeHead(200, { "content-length": asset.bytes.length });
  response.end(asset.bytes);
}

async function handleReleaseApi(request, response, state, url) {
  const releasePath = "/api/repos/acme/registry/releases";
  if (url.pathname === releasePath && request.method === "GET") {
    return json(response, 200, url.searchParams.get("page") === "2" ? [] : state.releases);
  }
  if (url.pathname === releasePath && request.method === "POST") {
    const input = JSON.parse((await readBody(request)).toString());
    if (state.releases.some((entry) => entry.tag_name === input.tag_name))
      return json(response, 422, {});
    const release = { ...input, id: state.nextReleaseId++ };
    state.releases.push(release);
    return json(response, 201, release);
  }
  const releaseMatch = url.pathname.match(/^\/api\/repos\/acme\/registry\/releases\/(\d+)$/);
  if (releaseMatch && request.method === "PATCH") {
    const release = state.releases.find((entry) => entry.id === Number(releaseMatch[1]));
    if (!release) return json(response, 404, {});
    const body = JSON.parse((await readBody(request)).toString());
    if (JSON.stringify(body) !== JSON.stringify({ draft: false, make_latest: "false" }))
      return json(response, 422, {});
    Object.assign(release, body);
    return json(response, 200, release);
  }
  const releaseAssetsMatch = url.pathname.match(
    /^\/api\/repos\/acme\/registry\/releases\/(\d+)\/assets$/,
  );
  if (releaseAssetsMatch && request.method === "GET") {
    const releaseId = Number(releaseAssetsMatch[1]);
    return json(
      response,
      200,
      state.assets
        .filter((asset) => asset.release_id === releaseId)
        .map(({ bytes: _bytes, ...asset }) => asset),
    );
  }
  if (url.pathname.startsWith(`${releasePath}/assets/`) && request.method === "GET") {
    const id = Number(url.pathname.split("/").at(-1));
    if (!state.assets.some((entry) => entry.id === id)) return json(response, 404, {});
    response.writeHead(302, {
      location: `https://release-assets.githubusercontent.com/${id}?opaque=test-only`,
    });
    response.end();
    return;
  }
  const uploadMatch = url.pathname.match(
    /^\/uploads\/repos\/acme\/registry\/releases\/(\d+)\/assets$/,
  );
  if (uploadMatch && request.method === "POST") {
    const releaseId = Number(uploadMatch[1]);
    const release = state.releases.find((entry) => entry.id === releaseId);
    if (!release) return json(response, 404, {});
    const name = url.searchParams.get("name");
    if (state.assets.some((entry) => entry.release_id === releaseId && entry.name === name))
      return json(response, 422, {});
    const bytes = await readBody(request);
    const asset = {
      id: state.nextId++,
      release_id: releaseId,
      name,
      size: bytes.length,
      state: "uploaded",
      browser_download_url: `https://github.com/acme/registry/releases/download/${release.tag_name}/${name}`,
    };
    state.assets.push({ ...asset, bytes });
    return json(response, 201, asset);
  }
  return json(response, 404, {});
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("fixture body exceeded test limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

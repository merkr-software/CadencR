import { createServer } from "node:http";

export async function startGitHubFixture(t, token) {
  const state = { release: null, assets: [], requests: [], nextId: 1 };
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
  const expectedAuth = isCdn ? undefined : `Bearer ${token}`;
  if (request.headers.authorization !== expectedAuth) return json(response, 403, {});
  if (isCdn) {
    const asset = state.assets.find((entry) => entry.id === Number(url.pathname.split("/").at(-1)));
    if (!asset) return json(response, 404, {});
    response.writeHead(200, { "content-length": asset.bytes.length });
    response.end(asset.bytes);
    return;
  }
  const releasePath = "/api/repos/acme/registry/releases";
  if (url.pathname === releasePath && request.method === "GET") {
    return json(
      response,
      200,
      url.searchParams.get("page") === "2" ? [] : state.release ? [state.release] : [],
    );
  }
  if (url.pathname === releasePath && request.method === "POST") {
    if (state.release) return json(response, 422, {});
    state.release = { ...JSON.parse((await readBody(request)).toString()), id: 42 };
    return json(response, 201, state.release);
  }
  if (url.pathname === `${releasePath}/42/assets` && request.method === "GET") {
    return json(
      response,
      200,
      state.assets.map(({ bytes: _bytes, ...asset }) => asset),
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
  if (
    url.pathname === "/uploads/repos/acme/registry/releases/42/assets" &&
    request.method === "POST"
  ) {
    const name = url.searchParams.get("name");
    if (state.assets.some((entry) => entry.name === name)) return json(response, 422, {});
    const bytes = await readBody(request);
    const asset = {
      id: state.nextId++,
      name,
      size: bytes.length,
      state: "uploaded",
      browser_download_url: `https://github.com/acme/registry/releases/download/${state.release.tag_name}/${name}`,
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

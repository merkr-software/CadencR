import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const rootRequire = createRequire(import.meta.url);

function manifestPath(packageName) {
  try {
    return rootRequire.resolve(`${packageName}/package.json`);
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    let directory = dirname(rootRequire.resolve(packageName));
    while (directory !== dirname(directory)) {
      const candidate = join(directory, "package.json");
      try {
        const manifest = JSON.parse(readFileSync(candidate, "utf8"));
        if (manifest.name === packageName) return candidate;
      } catch (readError) {
        if (readError?.code !== "ENOENT") throw readError;
      }
      directory = dirname(directory);
    }
    throw error;
  }
}

function dependency(owner, dependencyName) {
  const ownerPath = manifestPath(owner);
  const ownerManifest = JSON.parse(readFileSync(ownerPath, "utf8"));
  const declared = { ...ownerManifest.optionalDependencies, ...ownerManifest.dependencies };
  assert.ok(declared[dependencyName], `${owner} must declare ${dependencyName}`);

  const ownerRequire = createRequire(ownerPath);
  return ownerRequire.resolve(dependencyName);
}

function runIsolated(entry, source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source, entry], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("AJV consumes a hardened fast-uri while valid URI operations still work", async () => {
  const entry = dependency("ajv", "fast-uri");
  const imported = await import(pathToFileURL(entry));
  const uri = imported.default ?? imported;

  assert.equal(uri.normalize("HTTPS://Example.COM/a/../b"), "https://example.com/b");
  assert.equal(uri.normalize("http://%45XAMPLE.com/"), "http://example.com/");
  assert.match(uri.parse("http://[::not-valid]/private").error, /host/i);
  assert.notEqual(
    uri.normalize("http://%256c%256f%2563%2561%256c%2568%256f%2573%2574/"),
    "http://localhost/",
  );
  assert.throws(
    () => uri.serialize({ scheme: "http", host: "trusted.example", port: "@evil.example" }),
    /port/i,
  );
});

test("Mermaid's DOMPurify neutralizes descendants detached by after-sanitize hooks", (context) => {
  const { JSDOM } = rootRequire("jsdom");
  const { window } = new JSDOM("<!DOCTYPE html><body></body>");
  context.after(() => window.close());
  const createDOMPurify = rootRequire(dependency("mermaid", "dompurify"));

  for (const hook of ["afterSanitizeElements", "afterSanitizeAttributes"]) {
    const purifier = createDOMPurify(window);
    const root = window.document.createElement("div");
    root.innerHTML = '<section id="detached"><img src="x" onerror="alert(1)"></section>';
    window.document.body.append(root);
    const image = root.querySelector("img");
    purifier.addHook(hook, (node) => {
      if (node.id === "detached") node.remove();
    });

    purifier.sanitize(root, { IN_PLACE: true });

    assert.equal(root.querySelector("section"), null, `${hook} must detach the subtree`);
    assert.equal(image.hasAttribute("onerror"), false, `${hook} left an armed handler`);
    assert.equal(purifier.sanitize("<b>safe</b>"), "<b>safe</b>");
    root.remove();
  }
});

test("electron-updater consumes js-yaml with bounded omap and merge processing", () => {
  const entry = dependency("electron-updater", "js-yaml");
  const output = runIsolated(
    entry,
    `import { createRequire } from "node:module";
const yaml = createRequire(import.meta.url)(process.argv[1]);
const ordinary = yaml.load("channel: stable\\nfiles:\\n  - app.zip\\n");
if (ordinary.channel !== "stable" || ordinary.files[0] !== "app.zip") process.exit(2);
const omap = "!!omap\\n" + Array.from({ length: 10000 }, (_, i) => \`- k\${i}: \${i}\`).join("\\n");
yaml.load(omap);
let bounded = false;
try { yaml.load("target:\\n  <<: [{}, {}, {}]\\n", { maxTotalMergeKeys: 2 }); }
catch (error) { bounded = /merge keys exceeded maxTotalMergeKeys/.test(error.message); }
if (!bounded) process.exit(3);
console.log("ok");`,
  );
  assert.equal(output, "ok");
});

test("every build-tool minimatch line consumes its patched brace-expansion line", async () => {
  const owners = ["@electron/asar", "filelist", "@electron/universal", "app-builder-lib"];
  for (const owner of owners) {
    const entry = dependency(owner, "minimatch");
    const minimatchRequire = createRequire(entry);
    const braceEntry = minimatchRequire.resolve("brace-expansion");
    const brace = await import(pathToFileURL(braceEntry));
    const expand = brace.expand ?? brace.default;
    assert.deepEqual(expand("release-{mac,win}-{1..2}"), [
      "release-mac-1",
      "release-mac-2",
      "release-win-1",
      "release-win-2",
    ]);
    const bounded = expand("{aaaa,bbbb,cccc}", { max: 100, maxLength: 8 });
    assert.deepEqual(bounded, ["aaaa", "bbbb"]);
    assert.ok(bounded.reduce((length, value) => length + value.length, 0) <= 8);
  }
});

test("both Electron HTTP stacks consume hardened undici releases", async (context) => {
  for (const owner of ["node-gyp", "jsdom"]) {
    const entry = dependency(owner, "undici");
    const undici = await import(pathToFileURL(entry));
    const headers = new undici.Headers();
    assert.throws(
      () =>
        undici.setCookie(headers, {
          name: "session",
          value: "ok",
          domain: "example.com; Secure",
        }),
      /domain|invalid/i,
    );
    undici.setCookie(headers, { name: "session", value: "ok", domain: "example.com" });
    assert.match(headers.get("set-cookie"), /^session=ok; Domain=example\.com$/);

    const agent = new undici.MockAgent();
    context.after(() => agent.close());
    agent.disableNetConnect();
    agent
      .get("https://updates.cadencr.dev")
      .intercept({ path: "/health", method: "GET" })
      .reply(200, { channel: "stable" }, { headers: { "content-type": "application/json" } });
    const response = await undici.request("https://updates.cadencr.dev/health", {
      dispatcher: agent,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(await response.body.json(), { channel: "stable" });
  }
});

test("plist consumes xmldom that rejects malformed entity references", async () => {
  const entry = dependency("plist", "@xmldom/xmldom");
  const { DOMImplementation, XMLSerializer } = await import(pathToFileURL(entry));
  const document = new DOMImplementation().createDocument(null, "root", null);
  const serializer = new XMLSerializer();

  assert.throws(() => document.createEntityReference("safe; <injected/> &x"));
  const valid = document.createEntityReference("valid");
  assert.equal(serializer.serializeToString(valid, { requireWellFormed: true }), "&valid;");

  const plist = rootRequire("plist");
  const source = { CFBundleIdentifier: "com.cadencr.app", Enabled: true, Ports: [1420, 5005] };
  assert.deepEqual(plist.parse(plist.build(source)), source);
});

test("Astro consumes smol-toml that rejects an unterminated comment instead of hanging", () => {
  const entry = dependency("astro", "smol-toml");
  const output = runIsolated(
    entry,
    `const toml = await import(${JSON.stringify(pathToFileURL(entry).href)});
const parsed = toml.parse('title = "Cadencr"');
if (parsed.title !== "Cadencr") process.exit(2);
try { toml.parse("a=[1 #"); process.exit(3); } catch { console.log("rejected"); }`,
  );
  assert.equal(output, "rejected");
});

test("Excalidraw's replacement Sass still compiles nested SCSS with source maps", () => {
  const sass = rootRequire(dependency("@excalidraw/excalidraw", "sass"));
  const result = sass.compileString("$color: #10b981; .canvas { .label { color: $color; } }", {
    sourceMap: true,
  });
  assert.match(result.css, /\.canvas \.label/);
  assert.match(result.css, /color: #10b981/);
  assert.equal(result.sourceMap.version, 3);
  assert.ok(result.sourceMap.mappings.length > 0);
});

test("electron-builder's downloader still sends requests through global-agent v4", () => {
  const entry = dependency("app-builder-lib", "@electron/get");
  const output = runIsolated(
    entry,
    `import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
const proxy = http.createServer((request, response) => {
  assert.equal(request.url, "http://download.cadencr.invalid/artifact");
  response.end("proxied artifact");
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
process.env.GLOBAL_AGENT_HTTP_PROXY = "http://127.0.0.1:" + proxy.address().port;
process.env.GLOBAL_AGENT_NO_PROXY = "";
createRequire(import.meta.url)(process.argv[1]).initializeProxy();
try {
  const response = await new Promise((resolve, reject) => {
    http.get("http://download.cadencr.invalid/artifact", resolve).on("error", reject);
  });
  let body = "";
  for await (const chunk of response) body += chunk;
  assert.equal(body, "proxied artifact");
  console.log("ok");
} finally {
  proxy.closeAllConnections();
  await new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
}`,
  );
  assert.equal(output, "ok");
});

test("Mermaid's KaTeX ignores inherited trust while normal math still renders", () => {
  const entry = dependency("mermaid", "katex");
  const output = runIsolated(
    entry,
    `import assert from "node:assert/strict";
import { createRequire } from "node:module";
const katex = createRequire(import.meta.url)(process.argv[1]);
Object.prototype.trust = true;
try {
  const html = katex.renderToString(String.raw\`\\href{javascript:alert(1)}{click}\`, { output: "html" });
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(katex.renderToString("x^2 + y^2"), /katex/);
} finally {
  delete Object.prototype.trust;
}
console.log("ok");`,
  );
  assert.equal(output, "ok");
});

test("HTTP cache consumers revalidate security-restricted responses despite max-stale", () => {
  const request = { url: "/account", method: "GET", headers: {} };
  const responses = [
    { "cache-control": "max-age=3600", "set-cookie": "session=victim" },
    { "cache-control": "max-age=0, proxy-revalidate" },
    { "cache-control": "no-cache" },
    { "cache-control": "private, max-age=3600" },
    { "cache-control": "no-store" },
  ];
  for (const owner of ["astro", "cacheable-request"]) {
    const CachePolicy = rootRequire(dependency(owner, "http-cache-semantics"));
    for (const headers of responses) {
      const policy = new CachePolicy(request, {
        status: 200,
        headers: {
          ...headers,
          "cache-control": `${headers["cache-control"]}, stale-while-revalidate=3600`,
        },
      });
      for (const directive of ["max-stale", "max-stale=9999999", ""]) {
        const incoming = { ...request, headers: { "cache-control": directive } };
        const label = `${owner}: ${headers["cache-control"]} with ${directive || "no max-stale"}`;
        assert.equal(policy.satisfiesWithoutRevalidation(incoming), false, label);
        const result = policy.evaluateRequest(incoming);
        assert.equal(result.response, undefined, label);
        assert.equal(result.revalidation?.synchronous, true, label);
      }
    }
  }
});

test("HTTP cache policy preserves public reuse and respects Vary with max-stale", () => {
  const CachePolicy = rootRequire(dependency("astro", "http-cache-semantics"));
  const request = { url: "/account", method: "GET", headers: { authorization: "Bearer first" } };
  const policy = new CachePolicy(request, {
    status: 200,
    headers: { "cache-control": "private, max-age=0" },
  });
  assert.equal(policy.storable(), false);

  const varyingPolicy = new CachePolicy(request, {
    status: 200,
    headers: { "cache-control": "public, max-age=0", vary: "authorization" },
  });
  assert.equal(varyingPolicy.storable(), true);
  assert.equal(
    varyingPolicy.satisfiesWithoutRevalidation({
      ...request,
      headers: { authorization: "Bearer second", "cache-control": "max-stale" },
    }),
    false,
  );
  assert.equal(
    varyingPolicy.satisfiesWithoutRevalidation({
      ...request,
      headers: { ...request.headers, "cache-control": "max-stale" },
    }),
    true,
  );
  const publicPolicy = new CachePolicy(
    { url: "/public", method: "GET", headers: {} },
    { status: 200, headers: { "cache-control": "public, max-age=60" } },
  );
  assert.equal(
    publicPolicy.satisfiesWithoutRevalidation({ url: "/public", method: "GET", headers: {} }),
    true,
  );
  for (const [shared, directive] of [
    [true, "public"],
    [true, "immutable"],
    [false, "private"],
    [false, "proxy-revalidate"],
  ]) {
    const reusable = new CachePolicy(
      { url: "/public", method: "GET", headers: {} },
      {
        status: 200,
        headers: { "cache-control": `${directive}, max-age=0`, "set-cookie": "session=ok" },
      },
      { shared },
    );
    assert.equal(
      reusable.satisfiesWithoutRevalidation({
        url: "/public",
        method: "GET",
        headers: { "cache-control": "max-stale" },
      }),
      true,
      `${directive} in a ${shared ? "shared" : "private"} cache`,
    );
  }
});

test("TanStack Router's Seroval preserves typed arrays and cyclic route data", () => {
  const seroval = rootRequire(dependency("@tanstack/router-core", "seroval"));
  const source = { bytes: new Uint8Array([1, 2, 3]), routes: new Map([["home", "/"]]) };
  source.self = source;
  const result = seroval.fromJSON(seroval.toJSON(source));
  assert.deepEqual(result.bytes, source.bytes);
  assert.deepEqual(result.routes, source.routes);
  assert.equal(result.self, result);
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(new URL("../packages/desktop/package.json", import.meta.url));

function fixture(context) {
  const root = mkdtempSync(join(tmpdir(), "cadencr-packaging-security-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(join(source, "native"), { recursive: true });
  writeFileSync(join(source, "index.js"), "module.exports = 42;\n");
  writeFileSync(join(source, "native", "binding.node"), "native fixture\n");
  writeFileSync(join(source, ".hidden"), "hidden fixture\n");
  return { root, source };
}

test("ASAR packs files and unpacks native globs using the patched minimatch API", async (context) => {
  const { root, source } = fixture(context);
  const asar = require("@electron/asar");
  context.after(() => asar.uncacheAll());
  for (const [name, options] of [
    ["file", { unpack: "*.node" }],
    ["directory", { unpackDir: "**/native" }],
  ]) {
    const archive = join(root, `${name}.asar`);
    await asar.createPackageWithOptions(source, archive, options);
    assert.equal(asar.extractFile(archive, "index.js").toString(), "module.exports = 42;\n");
    assert.equal(asar.extractFile(archive, ".hidden").toString(), "hidden fixture\n");
    assert.equal(asar.statFile(archive, "native/binding.node").unpacked, true);
    assert.equal(
      readFileSync(join(`${archive}.unpacked`, "native", "binding.node"), "utf8"),
      "native fixture\n",
    );
  }
});

test("dir-compare applies include and exclude globs with the named minimatch export", async (context) => {
  const { root, source } = fixture(context);
  const other = join(root, "other");
  mkdirSync(join(other, "native"), { recursive: true });
  writeFileSync(join(other, "index.js"), "module.exports = 42;\n");
  const compare = require("dir-compare");
  for (const options of [{ includeFilter: "*.js" }, { excludeFilter: "native,.hidden" }]) {
    const result = await compare.compare(source, other, { ...options, compareContent: true });
    assert.equal(result.same, true);
    assert.equal(result.distinct, 0);
  }
  assert.equal((await compare.compare(source, other, { compareContent: true })).same, false);
});

test("legacy glob and filelist preserve recursive and brace matches with minimatch 11", (context) => {
  const { source } = fixture(context);
  const glob = require("glob");
  assert.deepEqual(glob.sync("**/*.{js,node}", { cwd: source }).sort(), [
    "index.js",
    "native/binding.node",
  ]);
  const { FileList } = require("filelist");
  const files = new FileList();
  files.include(join(source, "**", "*.{js,node}"));
  files.exclude(join(source, "**", "*.node"));
  assert.deepEqual(files.toArray(), [join(source, "index.js")]);
});

test("packaging minimatch bounds globparts amplification without dropping normal matches", () => {
  const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
  const { Minimatch } = builderRequire("minimatch");
  const options = { optimizationLevel: 2, braceExpandMax: 16 };
  const amplified = new Minimatch("**/../a/b/".repeat(8) + "file", options);
  assert.ok(amplified.globParts.length <= options.braceExpandMax);
  const matcher = new Minimatch("**/*.{js,node}", options);
  assert.equal(matcher.match("native/binding.node"), true);
  assert.equal(matcher.match("index.js"), true);
  assert.equal(matcher.match("README.md"), false);
});

test("legacy glob keeps dotfile and nonull brace alternatives in sync and callback modes", async (context) => {
  const { source } = fixture(context);
  const glob = require("glob");
  const callbackGlob = (pattern, options) =>
    new Promise((resolve, reject) => {
      glob(pattern, options, (error, matches) => (error ? reject(error) : resolve(matches)));
    });
  for (const run of [glob.sync, callbackGlob]) {
    assert.deepEqual((await run("{.*,*.js}", { cwd: source })).sort(), [".hidden", "index.js"]);
    assert.deepEqual((await run("missing/*.{js,node}", { cwd: source, nonull: true })).sort(), [
      "missing/*.js",
      "missing/*.node",
    ]);
    assert.deepEqual(await run("*.js", { cwd: source }), ["index.js"]);
    assert.deepEqual(await run("*.node", { cwd: source }), []);
    assert.deepEqual((await run("*.@(js|node)", { cwd: source })).sort(), ["index.js"]);
  }
});

test("legacy glob preserves escaped metacharacters on POSIX", async (context) => {
  const { source } = fixture(context);
  const glob = require("glob");
  writeFileSync(join(source, "literal*.js"), "escaped fixture\n");
  const pattern = String.raw`literal\*.js`;
  assert.deepEqual(glob.sync(pattern, { cwd: source }), ["literal*.js"]);
  const matches = await new Promise((resolve, reject) => {
    glob(pattern, { cwd: source }, (error, files) => (error ? reject(error) : resolve(files)));
  });
  assert.deepEqual(matches, ["literal*.js"]);
});

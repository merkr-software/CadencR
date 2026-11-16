import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const fromLanding = createRequire(new URL("../packages/landing/package.json", import.meta.url));
const fromAstro = createRequire(fromLanding.resolve("astro/package.json"));
const fromBrand = createRequire(new URL("../packages/brand/package.json", import.meta.url));
const sharp = fromAstro("sharp");
const semver = fromAstro("semver");
const { stripRequestBase } = await import(
  pathToFileURL(fromAstro.resolve("@astrojs/internal-helpers/path"))
);
const { default: imageService } = await import(
  pathToFileURL(fromLanding.resolve("astro/assets/services/sharp"))
);
const imageConfig = { service: { config: { limitInputPixels: 4096 } } };
const source = { create: { width: 32, height: 16, channels: 4, background: "#10b981" } };

test("Astro and brand generation load a patched native libheif", () => {
  for (const owner of [fromAstro, fromBrand]) {
    const { versions } = owner("sharp");
    assert.ok(semver.gte(versions.heif, "1.23.2"), `unpatched native libheif ${versions.heif}`);
  }
});

test("Astro and brand generation load a patched librsvg and still render SVG", async () => {
  const input = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="#10b981"/></svg>',
  );
  for (const owner of [fromAstro, fromBrand]) {
    const sharp = owner("sharp");
    assert.ok(
      semver.gte(sharp.versions.rsvg, "2.63.2"),
      `unpatched librsvg ${sharp.versions.rsvg}`,
    );
    const output = await sharp(input).png().toBuffer();
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, 32);
    assert.equal(metadata.height, 16);
    assert.equal(metadata.format, "png");
  }
});

test("Astro strips only complete base-path segments", () => {
  for (const base of ["/docs", "/docs/"]) {
    assert.equal(stripRequestBase("/docs", base), "/");
    assert.equal(stripRequestBase("/docs/", base), "/");
    assert.equal(stripRequestBase("/docs/private", base), "/private");
    for (const pathname of ["/docs-archive/private", "/docsprivate", "/docs%2fprivate"]) {
      assert.equal(stripRequestBase(pathname, base), pathname);
    }
  }
  assert.equal(stripRequestBase("/docs/private", "/"), "/docs/private");
});

test("Astro's image service preserves the landing PNG-to-WebP transform", async () => {
  const input = await sharp(source).png().toBuffer();
  const output = await imageService.transform(
    input,
    { src: "fixture.png", width: 16, format: "webp", quality: 78 },
    imageConfig,
  );
  const metadata = await sharp(output.data).metadata();
  assert.equal(output.format, "webp");
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 16);
  assert.equal(metadata.height, 8);
});

test("Astro decodes valid AVIF through the patched native image pipeline", async () => {
  const input = await sharp(source).avif({ effort: 0 }).toBuffer();
  const output = await imageService.transform(
    input,
    { src: "fixture.avif", width: 16, format: "png" },
    imageConfig,
  );
  const metadata = await sharp(output.data).metadata();
  assert.equal(output.format, "png");
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 16);
  assert.equal(metadata.height, 8);
});

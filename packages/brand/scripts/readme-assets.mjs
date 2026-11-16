// Actual v0.14.1 UI, captured with example conversations in an isolated workspace.
// This recipe owns framing and the lockup; source captures stay unretouched.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { markBody } from "../src/svg/mark.mjs";
import { outlinedText, TAGLINE, WORDMARK } from "../src/svg/wordmark.mjs";
import { EMERALD, GROUND, HAIRLINE, INK, SOFT, STANDARD_CUT } from "../src/tokens.mjs";
import { rawPixels } from "../src/encode/raster.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = path.join(root, ".github/assets/readme/source/v0.14.1");
const output = path.join(root, ".github/assets/readme");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check")) {
  throw new Error("Only --check is supported. See packages/brand/README.md.");
}
const check = args.includes("--check");

function svg(width, height, body) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
  );
}

function lockup() {
  return svg(
    1560,
    140,
    `<g transform="translate(0 12) scale(2.4)">${markBody(STANDARD_CUT, INK, EMERALD)}</g>
    ${outlinedText({ glyphs: WORDMARK, x: 144, y: 72, height: 48, fill: INK })}
    ${outlinedText({ glyphs: TAGLINE, x: 147, y: 116, height: 19, fill: SOFT })}`,
  );
}

async function capture(file, width) {
  const image = sharp(path.join(source, file));
  const meta = await image.metadata();
  const height = Math.round((meta.height * width) / meta.width);
  const radius = 14;
  const mask = svg(width, height, `<rect width="100%" height="100%" rx="${radius}" fill="white"/>`);
  const input = await image
    .resize(width, height)
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  const border = svg(
    width,
    height,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${radius}" fill="none" stroke="${HAIRLINE}"/>`,
  );
  return sharp(input)
    .composite([{ input: border }])
    .png()
    .toBuffer();
}

async function board(width, height, layers) {
  return sharp({ create: { width, height, channels: 4, background: GROUND } })
    .composite(layers)
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function framed(file, masthead = false) {
  const input = await capture(file, 1560);
  const { height } = await sharp(input).metadata();
  const top = masthead ? 198 : 60;
  const layers = [{ input, left: 60, top }];
  if (masthead) layers.unshift({ input: lockup(), left: 60, top: 20 });
  return board(1680, top + height + 60, layers);
}

async function hero() {
  return framed("agents.webp", true);
}

async function attention() {
  return framed("permission.webp");
}

async function review() {
  return framed("conversation.webp");
}

async function compareReadmeImage(expected, actual) {
  const [a, b] = await Promise.all([rawPixels(expected), rawPixels(actual)]);
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    return `expected ${a.width}x${a.height}x${a.channels}, found ${b.width}x${b.height}x${b.channels}`;
  }
  let absoluteDifference = 0;
  let visiblyDifferentPixels = 0;
  for (let offset = 0; offset < a.data.length; offset += a.channels) {
    let maxChannelDifference = 0;
    for (let channel = 0; channel < a.channels; channel++) {
      const difference = Math.abs(a.data[offset + channel] - b.data[offset + channel]);
      absoluteDifference += difference;
      maxChannelDifference = Math.max(maxChannelDifference, difference);
    }
    if (maxChannelDifference > 8) visiblyDifferentPixels++;
  }
  const meanDifference = absoluteDifference / a.data.length;
  const visiblyDifferentRatio = visiblyDifferentPixels / (a.width * a.height);
  // libvips resize/composite rounding varies slightly between macOS ARM and
  // Linux x64. Bound both the average channel drift and the affected area.
  if (meanDifference <= 2 && visiblyDifferentRatio <= 0.005) return null;
  return `pixels differ (mean channel delta ${meanDifference.toFixed(3)}, pixels with delta > 8: ${(visiblyDifferentRatio * 100).toFixed(3)}%)`;
}

// Both sides of --check are decoded to pixels, like the other brand assets.
// Encoder changes across platforms must not produce false drift failures.
const recipes = [
  ["hero.png", hero],
  ["attention.png", attention],
  ["review.png", review],
];
const drift = [];
for (const [name, render] of recipes) {
  const expected = await render();
  const file = path.join(output, name);
  if (!check) {
    await mkdir(output, { recursive: true });
    await writeFile(file, expected);
    console.log("wrote", path.relative(root, file));
    continue;
  }
  try {
    const reason = await compareReadmeImage(expected, await readFile(file));
    if (reason) drift.push(`${name}: ${reason}`);
  } catch (error) {
    drift.push(`${name}: ${error.message}`);
  }
}
if (drift.length) {
  throw new Error(`${drift.join("\n")}\nRun pnpm --filter @cadencr/brand readme:install.`);
}
if (check) console.log(`README assets up to date (${recipes.length} checked)`);

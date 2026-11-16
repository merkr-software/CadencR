// tsc emits declarations for the kit and for the desktop modules it re-exports
// (rootDir = packages/), with the `@/` alias left verbatim. Flatten them into
// dist/types/ and rewrite the alias into relative specifiers a consumer's
// TypeScript can follow:
//   tab-kit/src/**     → types/**
//   desktop/src/**     → types/desktop/**
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function relativeSpecifier(fromFile, toPath) {
  const specifier = relative(dirname(fromFile), toPath).split(sep).join("/");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

export function rewriteDeclarations(rawDir, outDir) {
  const mapping = [
    [join(rawDir, "tab-kit", "src"), outDir],
    [join(rawDir, "desktop", "src"), join(outDir, "desktop")],
  ];
  const desktopOut = join(outDir, "desktop");
  for (const file of walk(rawDir)) {
    if (!file.endsWith(".d.ts")) continue;
    const match = mapping.find(([from]) => file.startsWith(from + sep));
    if (!match) throw new Error(`Unexpected declaration outside the kit/desktop sources: ${file}`);
    const target = join(match[1], relative(match[0], file));
    const source = readFileSync(file, "utf8").replace(
      /(from\s+|import\()(["'])@\/([^"']+)\2/g,
      (_all, lead, quote, path) =>
        `${lead}${quote}${relativeSpecifier(target, join(desktopOut, path))}${quote}`,
    );
    if (source.includes('"@/') || source.includes("'@/")) {
      throw new Error(`Unrewritten @/ specifier left in ${target}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
}

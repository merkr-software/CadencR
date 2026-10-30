import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCAN_ROOTS = ["packages/service/src", "packages/desktop/src"];

const STATIC_ALLOWED_PREFIXES = [
  "packages/service/src/domain/agents/providers/registry",
  "packages/service/src/domain/agents/providers/opencode/",
  // Import adapters translate provider-owned history into neutral records.
  "packages/service/src/domain/imports/",
  "packages/service/src/domain/usage_stats/history_import/",
  // The desktop has one reviewed built-in metadata table until the deferred UI phase.
  "packages/desktop/src/lib/providers.ts",
  "packages/desktop/src/components/settings/ProvidersSection.tsx",
];

const ALLOWED_EXACT = new Map([
  // These are domain terms that happen to equal the Cursor provider id.
  ["packages/service/src/domain/themes/schema.rs:cursor", "CSS cursor property"],
  ["packages/service/src/domain/git/forge/github/review_threads.rs:cursor", "GraphQL cursor"],
  ["packages/service/src/domain/mcp/tools/workspace.rs:cursor", "pagination cursor"],
  ["packages/service/src/domain/mcp/tools/project_list.rs:cursor", "pagination cursor"],
  ["packages/service/src/domain/mcp/servers/project_schema.rs:cursor", "pagination cursor"],
  [
    "packages/service/src/domain/mcp/servers/project_schema_descriptions.rs:cursor",
    "pagination cursor",
  ],
  ["packages/service/src/domain/mcp/servers/workspace.rs:cursor", "pagination cursor"],
  ["packages/desktop/src/lib/mcp-tool-parser.ts:cursor", "MCP server name"],
]);

// Existing named-provider imports that still own behavior tracked by Phase 5.
// New files cannot join this list accidentally; every entry is a review point.
const LEGACY_NAMED_DEPENDENCY_FILES = new Set([
  "packages/service/src/api/mod.rs",
  "packages/service/src/api/openapi.rs",
  "packages/service/src/main.rs",
  // OpenCode agent modes still use their legacy wire codec from shared mode parsing.
  "packages/service/src/domain/agents/permission_modes.rs",
  "packages/service/src/domain/mcp/control/spawn_resolve.rs",
  "packages/service/src/domain/ws_session/routes.rs",
  "packages/service/src/domain/ws_session/slash_commands/mod.rs",
  "packages/service/src/domain/ws_session/handler/commands.rs",
  "packages/service/src/domain/ws_session/handler/session_compact.rs",
  "packages/service/src/domain/ws_session/handler/session_control/mode.rs",
  "packages/service/src/domain/ws_session/handler/session_control/provider.rs",
  "packages/service/src/domain/ws_session/handler/session_init.rs",
]);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function isTestOrGenerated(path) {
  return (
    /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/.test(path) ||
    /\.(?:test|spec)\.[^.]+$/.test(path) ||
    /_tests\.rs$/.test(path) ||
    path === "packages/desktop/src/api/generated/index.ts" ||
    path.endsWith("routeTree.gen.ts")
  );
}

function braceDelta(line) {
  let delta = 0;
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (!quote && char === "/" && next === "/") break;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    // Rust lifetimes (`&'static`) are much more common than brace-containing
    // character literals, so only mask string delimiters here.
    if (char === '"' || char === "`") quote = char;
    else if (char === "{") delta += 1;
    else if (char === "}") delta -= 1;
  }
  return delta;
}

/// Omit Rust items gated by `#[cfg(test)]` without ignoring production items
/// that follow an early `#[cfg(test)] mod fixture;` declaration.
export function productionLines(source, extension) {
  const lines = source.split("\n");
  if (extension !== ".rs") return lines.map((text, index) => ({ text, line: index + 1 }));
  const kept = [];
  let pendingTestItem = false;
  let skippedDepth = null;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    if (skippedDepth !== null) {
      skippedDepth += braceDelta(text);
      if (skippedDepth <= 0) skippedDepth = null;
      continue;
    }
    if (/^\s*#\[cfg\(test\)\]\s*$/.test(text)) {
      pendingTestItem = true;
      continue;
    }
    if (pendingTestItem) {
      if (/^\s*#\[/.test(text) || /^\s*$/.test(text)) continue;
      const delta = braceDelta(text);
      if (delta > 0) skippedDepth = delta;
      pendingTestItem = false;
      continue;
    }
    kept.push({ text, line: index + 1 });
  }
  return kept;
}

export function stringLiterals(line, extension) {
  const values = [];
  let quote = null;
  let value = "";
  const delimiters = extension === ".rs" ? new Set(['"']) : new Set(['"', "'", "`"]);
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (!quote && char === "/" && next === "/") break;
    if (!quote && delimiters.has(char)) {
      quote = char;
      value = "";
      continue;
    }
    if (!quote) continue;
    if (char === "\\") {
      value += next ?? "";
      index += 1;
    } else if (char === quote) {
      values.push(value);
      quote = null;
    } else {
      value += char;
    }
  }
  return values;
}

function codeBeforeComment(line) {
  let quote = null;
  for (let index = 0; index < line.length - 1; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "`") {
      quote = char;
    } else if (char === "/" && line[index + 1] === "/") {
      return line.slice(0, index);
    }
  }
  return line;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
}

function dynamicAllowedPrefixes(modules) {
  return modules.map((module) => `packages/service/src/domain/agents/${module}/`);
}

function allowed(path, providerId, allowedPrefixes) {
  return (
    allowedPrefixes.some((prefix) => path === prefix || path.startsWith(prefix)) ||
    ALLOWED_EXACT.has(`${path}:${providerId}`)
  );
}

function allowedNamedDependency(path, allowedPrefixes) {
  return (
    allowedPrefixes.some(
      (prefix) =>
        prefix.startsWith("packages/service/") && (path === prefix || path.startsWith(prefix)),
    ) || LEGACY_NAMED_DEPENDENCY_FILES.has(path)
  );
}

function packageName(source, manifest) {
  const name = source.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!name) throw new Error(`could not read package name from ${manifest}`);
  return name;
}

/// `*-sdk-rs` folders that are not a provider's transport: the custom-tab
/// backend SDK carries the tab backend protocol, which the service speaks
/// for every tab regardless of provider.
const NON_PROVIDER_SDK_DIRS = new Set(["tab-backend-sdk-rs"]);

function providerSdkMetadata(root) {
  return readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.endsWith("-sdk-rs") &&
        !NON_PROVIDER_SDK_DIRS.has(entry.name),
    )
    .map((entry) => {
      const manifest = `packages/${entry.name}/Cargo.toml`;
      const source = readFileSync(join(root, manifest), "utf8");
      return {
        manifest,
        crate: packageName(source, manifest).replaceAll("-", "_"),
        source,
      };
    });
}

/// Derive the boundary vocabulary from the registry table the service compiles,
/// so adding a built-in automatically extends the scanner.
export function providerBoundaryManifest(root = ROOT) {
  const registry = readFileSync(
    join(root, "packages/service/src/domain/agents/providers/registry.rs"),
    "utf8",
  );
  const modules = [
    ...registry.matchAll(/\bid:\s*super::super::([a-z][a-z0-9_]*)::PROVIDER_ID\b/g),
  ].map((match) => match[1]);
  if (modules.length === 0) throw new Error("BUILTIN_PROVIDERS contains no provider modules");

  const uniqueModules = [...new Set(modules)];
  const ids = uniqueModules.map((module) => {
    const source = readFileSync(
      join(root, `packages/service/src/domain/agents/${module}/mod.rs`),
      "utf8",
    );
    const id = source.match(/\bpub const PROVIDER_ID:\s*&str\s*=\s*"([^"]+)"\s*;/)?.[1];
    if (!id) throw new Error(`could not derive PROVIDER_ID for ${module}`);
    return id;
  });
  return { modules: uniqueModules, ids, sdk: providerSdkMetadata(root) };
}

function sourceWithLineMap(lines) {
  let source = "";
  const offsets = [];
  for (const item of lines) {
    offsets.push({ offset: source.length, line: item.line });
    source += `${codeBeforeComment(item.text)}\n`;
  }
  return { source, offsets };
}

function originalLine(offsets, index) {
  let line = offsets[0]?.line ?? 1;
  for (const entry of offsets) {
    if (entry.offset > index) break;
    line = entry.line;
  }
  return line;
}

function namedDependencies(lines, modules, sdkCrates) {
  const { source, offsets } = sourceWithLineMap(lines);
  const dependencies = [];
  const direct = new RegExp(
    `crate::domain::agents::(${modules.map(escapeRegex).join("|")})\\b`,
    "g",
  );
  for (const match of source.matchAll(direct)) {
    dependencies.push({ providerId: match[1], line: originalLine(offsets, match.index) });
  }
  const relative = new RegExp(
    `\\b(?:(?:super|self)::)+(${modules.map(escapeRegex).join("|")})\\b`,
    "g",
  );
  for (const match of source.matchAll(relative)) {
    dependencies.push({ providerId: match[1], line: originalLine(offsets, match.index) });
  }
  for (const match of source.matchAll(/crate::domain::agents::\{([\s\S]*?)\}/g)) {
    for (const module of modules) {
      const moduleMatch = new RegExp(`\\b${escapeRegex(module)}\\b`).exec(match[1]);
      if (moduleMatch) {
        const index = match.index + match[0].indexOf(match[1]) + moduleMatch.index;
        dependencies.push({ providerId: module, line: originalLine(offsets, index) });
      }
    }
  }
  if (sdkCrates.length > 0) {
    const sdkPattern = new RegExp(`\\b(${sdkCrates.map(escapeRegex).join("|")})\\b`, "g");
    for (const match of source.matchAll(sdkPattern)) {
      dependencies.push({ providerId: match[1], line: originalLine(offsets, match.index) });
    }
  }
  return dependencies;
}

export function scanProviderBoundaries(root = ROOT) {
  const violations = [];
  const manifest = providerBoundaryManifest(root);
  const providerIds = new Set(manifest.ids);
  const allowedPrefixes = [...dynamicAllowedPrefixes(manifest.modules), ...STATIC_ALLOWED_PREFIXES];

  for (const scanRoot of SCAN_ROOTS) {
    const absoluteRoot = join(root, scanRoot);
    for (const absolutePath of walk(absoluteRoot)) {
      const path = relative(root, absolutePath).split(sep).join("/");
      const extension = extname(path);
      if (![".rs", ".ts", ".tsx"].includes(extension) || isTestOrGenerated(path)) continue;
      const source = readFileSync(absolutePath, "utf8");
      const lines = productionLines(source, extension);
      for (const { text, line } of lines) {
        for (const providerId of stringLiterals(text, extension)) {
          if (providerIds.has(providerId) && !allowed(path, providerId, allowedPrefixes)) {
            violations.push({ path, line, providerId, source: text.trim() });
          }
        }
      }
      if (path.startsWith("packages/service/") && !allowedNamedDependency(path, allowedPrefixes)) {
        for (const dependency of namedDependencies(
          lines,
          manifest.modules,
          manifest.sdk.map((entry) => entry.crate),
        )) {
          const text = lines.find(({ line }) => line === dependency.line)?.text ?? "";
          violations.push({
            path,
            line: dependency.line,
            providerId: dependency.providerId,
            source: text.trim(),
            kind: "dependency",
          });
        }
      }
    }
  }

  for (const sdk of manifest.sdk) {
    if (/cadencr-service|packages\/service/.test(sdk.source)) {
      violations.push({
        path: sdk.manifest,
        line: 1,
        providerId: "cadencr-service",
        source: "provider SDK depends on the service crate",
        kind: "dependency",
      });
    }
  }
  return violations;
}

export function formatViolations(violations) {
  return violations
    .map(({ path, line, providerId, source, kind }) =>
      kind === "dependency"
        ? `${path}:${line}: named provider dependency ${JSON.stringify(providerId)} outside an approved boundary\n  ${source}`
        : `${path}:${line}: hardcoded provider id ${JSON.stringify(providerId)} outside an approved boundary\n  ${source}`,
    )
    .join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = scanProviderBoundaries();
  if (violations.length > 0) {
    console.error(formatViolations(violations));
    console.error(
      "Move provider behavior into its adapter/registry metadata, or add a narrowly reviewed non-provider false-positive exception.",
    );
    process.exitCode = 1;
  } else {
    console.log("Provider boundary scan passed.");
  }
}

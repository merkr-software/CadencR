import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

const BEGIN = "<!-- begin:rules -->";
const END = "<!-- end:rules -->";
const NESTED_HEADER =
  "<!-- auto-generated from .claude/rules/ — edit those files and run pnpm build:agents-md -->";

// Directories that have their own nested AGENTS.md, ordered deepest-first so a
// glob is matched against the most specific directory it falls under.
const CANDIDATE_DIRS = [
  "packages/desktop/src/components",
  "packages/desktop/src/routes",
  "packages/service/migrations",
  "packages/desktop/src",
];

// Each nested AGENTS.md target keeps its own one-line intro.
const NESTED_TARGETS = [
  {
    dir: "packages/desktop/src",
    intro: "These rules apply to frontend source under `packages/desktop/src/`.",
  },
  {
    dir: "packages/desktop/src/components",
    intro: "These rules apply to `packages/desktop/src/components/`.",
  },
  {
    dir: "packages/desktop/src/routes",
    intro: "These rules apply to `packages/desktop/src/routes/`.",
  },
  {
    dir: "packages/service/migrations",
    intro: "These rules apply to SQL migrations in `packages/service/migrations/`.",
  },
];

// Parse a rule file into { name, paths, body }. Frontmatter is optional and only
// its `paths:` list is consumed.
export function parseRule(name, content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) {
    return { name, paths: [], body: content.trim() };
  }
  return {
    name,
    paths: parsePaths(fmMatch[1]),
    body: content.slice(fmMatch[0].length).trim(),
  };
}

function parsePaths(frontmatter) {
  const paths = [];
  let collecting = false;
  for (const line of frontmatter.split("\n")) {
    if (!collecting) {
      if (/^paths:\s*$/.test(line)) collecting = true;
      continue;
    }
    const item = line.match(/^\s+-\s*(.+?)\s*$/);
    if (item) {
      paths.push(stripQuotes(item[1]));
    } else if (line.trim() === "") {
      continue;
    } else {
      // A new, non-indented key ends the paths list.
      collecting = false;
    }
  }
  return paths;
}

function stripQuotes(value) {
  const match = value.match(/^(['"])(.*)\1$/);
  return match ? match[2] : value;
}

// Demote every markdown heading (## or deeper) by one level so rule bodies nest
// under the generated `### <name>` heading. Fenced code blocks are left alone.
export function demoteHeadings(body) {
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (!inFence && /^#{2,}\s/.test(line)) return `#${line}`;
      return line;
    })
    .join("\n");
}

function ruleBlock(rule) {
  let out = `### ${rule.name}\n`;
  if (rule.paths.length > 0) {
    out += `_Applies to: ${rule.paths.map((p) => `\`${p}\``).join(", ")}_\n`;
  }
  out += `\n${demoteHeadings(rule.body)}\n`;
  return out.trimEnd();
}

// Map a single glob to the deepest nested directory it belongs to, or null when
// it stays root-only.
function mapGlob(glob) {
  if (glob === "**/*.ts" || glob === "**/*.tsx") return "packages/desktop/src";
  if (glob === "**/*.rs") return null;
  for (const dir of CANDIDATE_DIRS) {
    if (glob === dir || glob.startsWith(`${dir}/`)) return dir;
  }
  return null;
}

export function mapRuleToDirs(paths) {
  const dirs = new Set();
  for (const glob of paths) {
    const dir = mapGlob(glob);
    if (dir) dirs.add(dir);
  }
  return [...dirs];
}

function byName(a, b) {
  return a.name.localeCompare(b.name);
}

// Replace only the content between the begin/end markers, leaving the rest of
// the root AGENTS.md untouched.
export function renderRoot(existing, rules) {
  const inner = [...rules].sort(byName).map(ruleBlock).join("\n\n");
  const replacement = `${BEGIN}\n\n${inner}\n\n${END}`;
  const re = new RegExp(`${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}`);
  if (!re.test(existing)) {
    throw new Error("root AGENTS.md is missing the begin:rules/end:rules markers");
  }
  return existing.replace(re, replacement);
}

export function renderNested(intro, rules) {
  let out = `${NESTED_HEADER}\n\n# AGENTS.md\n\n${intro}\n`;
  for (const rule of [...rules].sort(byName)) {
    out += `\n${ruleBlock(rule)}\n`;
  }
  return out.replace(/\n+$/, "\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadRules(rulesDir) {
  return readdirSync(rulesDir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => parseRule(file.replace(/\.md$/, ""), readFileSync(join(rulesDir, file), "utf8")));
}

// Build the full set of { path, content } outputs from the current rules.
export function buildOutputs(root, rules) {
  const rootPath = join(root, "AGENTS.md");
  const rootExisting = readFileSync(rootPath, "utf8");
  const outputs = [{ path: rootPath, content: renderRoot(rootExisting, rules) }];
  for (const target of NESTED_TARGETS) {
    const scoped = rules.filter((rule) => mapRuleToDirs(rule.paths).includes(target.dir));
    outputs.push({
      path: join(root, target.dir, "AGENTS.md"),
      content: renderNested(target.intro, scoped),
    });
  }
  return outputs;
}

function readOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function main() {
  const check = process.argv.includes("--check");
  const rules = loadRules(join(repoRoot, ".claude/rules"));
  const outputs = buildOutputs(repoRoot, rules);
  const changed = outputs.filter((out) => readOrNull(out.path) !== out.content);

  if (check) {
    if (changed.length === 0) return;
    console.error("AGENTS.md files are out of date. Run `pnpm build:agents-md` to regenerate:");
    for (const out of changed) console.error(`  ${relative(repoRoot, out.path)}`);
    process.exit(1);
  }

  for (const out of changed) writeFileSync(out.path, out.content);
  if (changed.length === 0) {
    console.log("AGENTS.md files already up to date.");
    return;
  }
  console.log("Regenerated AGENTS.md files:");
  for (const out of changed) console.log(`  ${relative(repoRoot, out.path)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main();
}

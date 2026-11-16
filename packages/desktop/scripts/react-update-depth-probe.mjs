/**
 * Build a separate, readable production renderer that observes React's #185
 * counter. No application source, installed dependency, or React limit changes.
 * Run from any directory: node packages/desktop/scripts/react-update-depth-probe.mjs
 * Serve the printed URL with this worktree's normal `pnpm dev`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, loadConfigFromFile, loadEnv } from "vite";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// This is deliberately version-specific. Refuse to instrument a changed React
// implementation instead of silently observing the wrong part of the commit.
const MARKER = "    flushSyncWorkAcrossRoots_impl(0, !1);\n  }\n}\nfunction releaseRootPooledCache";

function observeCommit(root, depth, lanes, remainingLanes) {
  const key = "__CADENCR_REACT_DEPTH_PROBE__";
  let stats = window[key];
  if (!stats) {
    stats = window[key] = { commits: 0, maximum: 0, counts: {}, recent: [] };
    const report = () => console.info("CADENCR_REACT_DEPTH_SNAPSHOT " + JSON.stringify(stats));
    window.addEventListener("error", report);
    window.addEventListener("beforeunload", report);
  }
  stats.commits++;
  stats.counts[depth] = (stats.counts[depth] || 0) + 1;
  stats.recent.push({ depth, lanes, remainingLanes, at: performance.now() });
  if (stats.recent.length > 80) stats.recent.shift();
  const newMaximum = depth > stats.maximum;
  stats.maximum = Math.max(stats.maximum, depth);
  // A React boundary may catch #185 before a window "error" event reaches us.
  if (newMaximum && depth === 40) {
    console.info("CADENCR_REACT_DEPTH_SNAPSHOT " + JSON.stringify(stats));
  }
  if (!newMaximum && stats.commits !== 1 && stats.commits % 500 !== 0) return;

  // React's pending-update mask at this counter is 42 (Sync/Input/Default).
  // Inspect only those subtrees, cap the output, and never record props, state,
  // prompts, tokens, or message content. A pending fiber is a lead, not proof.
  const pending = [];
  const walk = (fiber, ancestors) => {
    if (!fiber || pending.length >= 60) return;
    const name =
      typeof fiber.type === "string"
        ? fiber.type
        : fiber.type?.displayName ||
          fiber.type?.name ||
          fiber.type?.render?.name ||
          `tag:${fiber.tag}`;
    const chain = [...ancestors, name].slice(-7);
    if (fiber.lanes & 42) pending.push({ name, lanes: fiber.lanes, chain });
    if (fiber.childLanes & 42) walk(fiber.child, chain);
    walk(fiber.sibling, ancestors);
  };
  walk(root.current, []);
  console.info(
    "CADENCR_REACT_DEPTH " +
      JSON.stringify({
        commits: stats.commits,
        depth,
        maximum: stats.maximum,
        counts: stats.counts,
        lanes,
        remainingLanes,
        pending,
      }),
  );
}

function depthProbePlugin() {
  let instrumented = 0;
  return {
    name: "cadencr-react-update-depth-probe",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/react-dom-client.production.js")) return;
      const preceding = code.slice(Math.max(0, code.indexOf(MARKER) - 800), code.indexOf(MARKER));
      if (
        code.split(MARKER).length !== 2 ||
        !preceding.includes("passiveSubtreeMask = root.pendingLanes;") ||
        !preceding.includes("0 !== (lanes & 261930) && 0 !== (passiveSubtreeMask & 42)") ||
        !preceding.includes("nestedUpdateCount++")
      ) {
        throw new Error("React commit implementation changed; review the probe before using it.");
      }
      instrumented++;
      const probe = `(${observeCommit.toString()})(root, nestedUpdateCount, lanes, passiveSubtreeMask);`;
      return { code: code.replace(MARKER, probe + "\n" + MARKER), map: null };
    },
    generateBundle() {
      if (instrumented !== 1) {
        throw new Error(`Expected one production React client, instrumented ${instrumented}.`);
      }
    },
  };
}

async function main() {
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    path.join(desktop, "electron.vite.config.ts"),
    desktop,
  );
  const renderer = loaded?.config.renderer;
  if (!renderer) throw new Error("Could not load the worktree's renderer configuration.");
  const name = `react-depth-probe-${Date.now()}`;
  const outDir = path.join(desktop, "public", name);
  await build({
    ...renderer,
    configFile: false,
    root: desktop,
    base: `/${name}/`,
    publicDir: false,
    plugins: [depthProbePlugin(), ...(renderer.plugins ?? [])],
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      rollupOptions: { input: path.join(desktop, "index.html") },
    },
  });
  const env = loadEnv("production", desktop, "VITE_");
  console.info(
    `\nProbe: http://127.0.0.1:${env.VITE_FRONTEND_PORT || "1420"}/${name}/index.html#/agents`,
  );
  console.info(`Generated files: ${outDir}`);
  console.info("Console filter: CADENCR_REACT_DEPTH (a snapshot is also logged before reload).");
  console.info("This build is for local investigation only; do not package or publish it.");
}

main().catch((error) => {
  console.error("React update-depth probe build failed:", error);
  process.exitCode = 1;
});

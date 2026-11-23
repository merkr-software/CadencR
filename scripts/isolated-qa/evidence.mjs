// The evidence summary an agent completes for one QA run. It lives in the run
// directory, never in a tracked file (rule `no-session-docs`): its content goes
// into the agent's reply or the PR description.

export const SURFACES = {
  electron: "Real Electron dev app (desktop shell, IPC and in-app browser available)",
  renderer:
    "Renderer only, in a headless Chrome (no Electron shell: no IPC, in-app browser, menus)",
  service: "Service API only (no UI)",
};

const PLATFORM_NAMES = { darwin: "macOS", linux: "Linux" };

/** What this run cannot prove about the other supported platform. */
export function unvalidatedPlatforms(platform) {
  return Object.entries(PLATFORM_NAMES)
    .filter(([id]) => id !== platform)
    .map(([, name]) => `${name}: not run (this run is on ${PLATFORM_NAMES[platform] ?? platform})`);
}

export function surfaceLimits(surface) {
  if (surface === "electron") return [];
  if (surface === "renderer") {
    return [
      "Desktop-only behaviour (Electron IPC, in-app browser, native menus, notch, window chrome) not exercised.",
    ];
  }
  return ["No UI exercised: API responses only."];
}

export function evidenceTemplate({
  runId,
  runDir,
  sha,
  branch,
  dirty,
  surface,
  platform,
  release,
  arch,
  startedAt,
}) {
  const commit = `\`${sha}\`${branch ? ` on \`${branch}\`` : ""}${
    dirty ? " **plus uncommitted changes** (list them under Limits)" : ""
  }`;
  const limits = [...surfaceLimits(surface), "<anything not tested, flaky or stubbed>"];
  return [
    `# QA evidence: ${runId}`,
    "",
    "Complete every `<…>` placeholder, then copy this summary into the reply or PR description.",
    "This file stays in the run directory; never commit it.",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Tested commit | ${commit} |`,
    `| Surface | ${SURFACES[surface]} |`,
    `| Platform | ${PLATFORM_NAMES[platform] ?? platform} ${release} (${arch}) |`,
    `| Run | \`${runDir}\` (started ${startedAt}) |`,
    "",
    "Change the surface line if the checks ran elsewhere (for example an HTML bench that",
    "renders components without the app): say so plainly, it changes what the result proves.",
    "",
    "## Scenarios",
    "",
    "| # | Scenario | Steps | Expected | Result |",
    "| --- | --- | --- | --- | --- |",
    "| 1 | <name> | <what was done> | <what should happen> | <PASS / FAIL / NOT RUN> |",
    "",
    "## Screenshots",
    "",
    `Saved under \`${runDir}/screenshots/\`; embed each with a caption:`,
    "",
    "<!-- ![caption](/absolute/path/to/shot.png) -->",
    "",
    "## Limits",
    "",
    ...limits.map((line) => `- ${line}`),
    "",
    "## Platforms not validated",
    "",
    ...unvalidatedPlatforms(platform).map((line) => `- ${line}`),
    "",
  ].join("\n");
}

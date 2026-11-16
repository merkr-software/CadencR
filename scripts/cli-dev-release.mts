import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const repository = "merkr-software/CadencR";
export function devVersion(base: string, run: string, attempt: string): string {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/.test(base) ||
    !/^[1-9]\d*(?![\s\S])/.test(run) ||
    !/^[1-9]\d*(?![\s\S])/.test(attempt)
  )
    throw new Error("Invalid version inputs");
  return `${base}-dev.${run}.${attempt}`;
}
export function validateContext(env: NodeJS.ProcessEnv, tip: string): void {
  if (
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    !/^[a-f0-9]{40}(?![\s\S])/.test(env.SOURCE_COMMIT ?? "") ||
    env.SOURCE_COMMIT !== env.GITHUB_SHA ||
    tip !== env.SOURCE_COMMIT
  ) {
    throw new Error("Only the reviewed canonical main tip may be released");
  }
}
export function ciPredicate(sha: string): string {
  if (!/^[a-f0-9]{40}(?![\s\S])/.test(sha)) throw new Error("Invalid source SHA");
  return `.workflow_runs as $runs |
    ($runs | type == "array") and
    (.total_count == ($runs | length)) and
    ([$runs[] | select(.head_sha == "${sha}" and .head_branch == "main" and
      .event == "push" and .repository.full_name == "${repository}")] |
      length > 0 and all(.status == "completed" and .conclusion == "success"))`;
}
export function validateCi(output: string): void {
  if (output !== "true\n") {
    throw new Error("Canonical main CI must have completed successfully on this exact SHA");
  }
}
function main(): void {
  const env = process.env;
  const tip = execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], {
    encoding: "utf8",
  }).trim();
  validateContext(env, tip);
  const ciOutput = execFileSync(
    "gh",
    [
      "api",
      `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${env.SOURCE_COMMIT}&event=push&branch=main&per_page=100`,
      "--jq",
      ciPredicate(env.SOURCE_COMMIT!),
    ],
    { encoding: "utf8" },
  );
  validateCi(ciOutput);
  const manifest = readFileSync("packages/cli/Cargo.toml", "utf8");
  const base = manifest.match(/^version = "([^"]+)"$/m)?.[1] ?? "";
  const version = devVersion(base, env.GITHUB_RUN_ID!, env.GITHUB_RUN_ATTEMPT!);
  if (process.argv[2] === "gate") {
    appendFileSync(env.GITHUB_OUTPUT!, `version=${version}\ntag=cli/v${version}\n`);
    return;
  }
  if (process.argv[2] !== "metadata") throw new Error("Expected gate or metadata");
  const asset = `cadencr-v${version}-x86_64-unknown-linux-gnu`;
  const sha256 = createHash("sha256")
    .update(readFileSync(`dist-cli/${asset}`))
    .digest("hex");
  writeFileSync(
    "dist-cli/released-cli.env",
    `CADENCR_RELEASE_VERSION=${version}\nCADENCR_RELEASE_TAG=cli/v${version}\nCADENCR_RELEASE_SHA256=${sha256}\n`,
    { flag: "wx" },
  );
  writeFileSync(
    "dist-cli/provenance.json",
    JSON.stringify(
      {
        repository,
        source_commit: env.SOURCE_COMMIT,
        version,
        tag: `cli/v${version}`,
        run_id: env.GITHUB_RUN_ID,
        run_attempt: env.GITHUB_RUN_ATTEMPT,
        workflow: ".github/workflows/cli-dev-release.yml",
        asset,
        sha256,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

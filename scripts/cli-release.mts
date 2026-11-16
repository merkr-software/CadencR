// Gate and metadata helper of .github/workflows/cli-release.yml (stable CLI
// releases on their own semver, tagged cli/vX.Y.Z). It reuses the development
// release's checks that the dispatch is the reviewed canonical main tip with
// green CI, and adds the stable rules: the version comes unchanged from the
// CLI manifests, which must agree, and its tag/release must not exist yet.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ciPredicate, repository, validateCi, validateContext } from "./cli-dev-release.mts";

export const workflow = ".github/workflows/cli-release.yml";

/** The stable X.Y.Z shared by the CLI's Cargo.toml and package.json. */
export function stableVersion(manifest: string, packageJson: string): string {
  const cargo = manifest.match(/^version = "([^"]+)"$/m)?.[1] ?? "";
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/.test(cargo))
    throw new Error("The CLI version must be a stable X.Y.Z");
  const { version } = JSON.parse(packageJson) as { version?: unknown };
  if (version !== cargo) throw new Error("packages/cli/package.json and Cargo.toml disagree");
  return cargo;
}

/** Fails unless GitHub definitively answers 404 for both the tag and the release. */
export function refuseExisting(tag: string): void {
  for (const endpoint of [`git/ref/tags/${tag}`, `releases/tags/${tag}`]) {
    const answer = spawnSync("gh", ["api", "--include", `repos/${repository}/${endpoint}`], {
      encoding: "utf8",
    });
    if (answer.status === 0) throw new Error(`Refusing existing tag or release ${tag}`);
    if (!/HTTP 404/.test(`${answer.stdout ?? ""}${answer.stderr ?? ""}`))
      throw new Error(`GitHub gave no definitive answer for ${endpoint}`);
  }
}

function gate(env: NodeJS.ProcessEnv): string {
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
  const version = stableVersion(
    readFileSync("packages/cli/Cargo.toml", "utf8"),
    readFileSync("packages/cli/package.json", "utf8"),
  );
  refuseExisting(`cli/v${version}`);
  return version;
}

function metadata(env: NodeJS.ProcessEnv, version: string): void {
  const tag = `cli/v${version}`;
  const asset = `cadencr-v${version}-x86_64-unknown-linux-gnu`;
  const sha256 = createHash("sha256")
    .update(readFileSync(`dist-cli/${asset}`))
    .digest("hex");
  writeFileSync(
    "dist-cli/released-cli.env",
    `CADENCR_RELEASE_VERSION=${version}\nCADENCR_RELEASE_TAG=${tag}\nCADENCR_RELEASE_SHA256=${sha256}\n`,
    { flag: "wx" },
  );
  const provenance = {
    repository,
    source_commit: env.SOURCE_COMMIT,
    version,
    tag,
    run_id: env.GITHUB_RUN_ID,
    run_attempt: env.GITHUB_RUN_ATTEMPT,
    workflow,
    asset,
    sha256,
  };
  writeFileSync("dist-cli/provenance.json", JSON.stringify(provenance, null, 2) + "\n", {
    flag: "wx",
  });
}

function main(): void {
  const env = process.env;
  const version = gate(env);
  if (process.argv[2] === "gate") {
    appendFileSync(env.GITHUB_OUTPUT!, `version=${version}\ntag=cli/v${version}\n`);
    return;
  }
  if (process.argv[2] !== "metadata") throw new Error("Expected gate or metadata");
  metadata(env, version);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

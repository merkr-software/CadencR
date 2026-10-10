import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function checkCliPreparation({ sourceCommit, sourceBranch, releaseTag, cwd }) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? "")) {
    throw new Error("source commit must be a full lowercase 40-character Git SHA");
  }
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(releaseTag ?? "")) {
    throw new Error("release tag must be an explicit stable vX.Y.Z version");
  }
  if (typeof sourceBranch !== "string" || sourceBranch.length === 0) {
    throw new Error("source branch must be explicitly provided");
  }
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("check-ref-format", `refs/heads/${sourceBranch}`);
  const tip = git("rev-parse", "--verify", "refs/remotes/cli-preparation/source^{commit}");
  if (tip !== sourceCommit)
    throw new Error("source commit is not the fetched coordinated branch tip");
  if (git("rev-parse", "--verify", `${sourceCommit}^{commit}`) !== sourceCommit) {
    throw new Error("source commit must identify a commit object");
  }
  const manifest = git("show", `${sourceCommit}:packages/cli/Cargo.toml`);
  const packageSection = manifest.match(/^\[package\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (version !== releaseTag.slice(1))
    throw new Error("requested version does not match the source CLI package version");
  return {
    source_commit: sourceCommit,
    source_branch: sourceBranch,
    release_tag: releaseTag,
    target: "x86_64-unknown-linux-gnu",
    publication: "not-authorized",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(
      JSON.stringify(
        checkCliPreparation({
          sourceCommit: process.env.SOURCE_COMMIT,
          sourceBranch: process.env.SOURCE_BRANCH,
          releaseTag: process.env.RELEASE_TAG,
          cwd: process.cwd(),
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`check-cli-preparation: ${error.message}`);
    process.exitCode = 1;
  }
}

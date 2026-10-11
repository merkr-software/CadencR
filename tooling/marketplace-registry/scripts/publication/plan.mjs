import { validateSubmission } from "../submission.mjs";

const REPOSITORY =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9_-])?$/;
const ARCHIVE_SUFFIXES = [".tar.bz2", ".tar.gz", ".tbz2", ".tgz", ".zip"];

export function createPublicationPlan(submission, repository) {
  const errors = validateSubmission(submission);
  if (errors.length > 0) throw new Error(`invalid submission:\n  - ${errors.join("\n  - ")}`);
  if (!validPublicationRepository(repository)) {
    throw new Error("repository must be an ASCII GitHub owner/repository name without dots");
  }

  const { agent } = submission.package;
  const releaseTag = `provider-${agent.id}-v${agent.version}`;
  const mirroredPackage = structuredClone(submission.package);
  const binary = mirroredPackage.agent.distribution.binary;
  const targets = Object.keys(binary)
    .sort()
    .map((target) => mirrorTarget(target, binary[target], repository, releaseTag));

  for (const target of targets) binary[target.target].archive = target.destination_url;

  return {
    schema_version: 1,
    repository,
    source: {
      submission: structuredClone(submission),
      identity: {
        provider_id: agent.id,
        version: agent.version,
        repository: submission.source.repository,
        commit: submission.source.commit,
        tag: submission.source.tag,
      },
    },
    release: { tag: releaseTag },
    targets,
    mirrored_package: mirroredPackage,
  };
}

export function validPublicationRepository(value) {
  return typeof value === "string" && value.length <= 140 && REPOSITORY.test(value);
}

function mirrorTarget(target, distribution, repository, releaseTag) {
  const suffix = archiveSuffix(distribution.archive);
  if (suffix === null) {
    throw new Error(
      `target ${target} archive must end in a supported .tar.gz, .tgz, .tar.bz2, .tbz2, or .zip suffix`,
    );
  }
  const sha256 = distribution.sha256.toLowerCase();
  const asset = `${target}-${sha256}${suffix}`;
  return {
    target,
    asset,
    source_url: distribution.archive,
    destination_url: `https://github.com/${repository}/releases/download/${releaseTag}/${asset}`,
    sha256,
  };
}

function archiveSuffix(value) {
  const pathname = new URL(value).pathname.toLowerCase();
  return ARCHIVE_SUFFIXES.find((suffix) => pathname.endsWith(suffix)) ?? null;
}

/**
 * Git endpoints name files relative to the checkout root, while the editor
 * (and every editor endpoint) names them relative to the feature's directory.
 * The two differ by the feature directory's `prefix` inside the checkout
 * (`GET /api/git/path-prefix`): empty for a project at the repository root,
 * `packages/app` for a monorepo project.
 */

/**
 * The feature-relative path of a Git path, or `null` when the file lies
 * outside the feature's directory and so cannot be opened in its editor.
 */
export function gitPathToFeaturePath(gitPath: string, prefix: string): string | null {
  if (prefix === "") return gitPath;
  const head = `${prefix}/`;
  return gitPath.startsWith(head) && gitPath.length > head.length
    ? gitPath.slice(head.length)
    : null;
}

/** The Git path of a feature-relative path. */
export function featurePathToGitPath(featurePath: string, prefix: string): string {
  return prefix === "" ? featurePath : `${prefix}/${featurePath}`;
}

/** Where the feature's directory sits in its checkout (`GET /api/git/path-prefix`). */
export interface GitPathMapping {
  prefix: string;
  /** Absolute path of the checkout root. */
  root: string;
}

/** Names a Git path the way the feature's agent resolves it (see `gitPathForAgent`). */
export type AgentPathMapper = (gitPath: string) => string;

/** Keeps the repository-relative spelling: the Git tab's own, and the fallback without Git metadata. */
export const keepGitPath: AgentPathMapper = (gitPath) => gitPath;

/**
 * How a Git path reads to the feature's agent, which runs in the feature's
 * directory: relative to that directory when the file lies inside it, and
 * absolute otherwise — a repository-relative path would be resolved against the
 * subdirectory (`packages/app/packages/app/x`).
 */
export function gitPathForAgent(gitPath: string, mapping: GitPathMapping): string {
  return gitPathToFeaturePath(gitPath, mapping.prefix) ?? `${mapping.root}/${gitPath}`;
}

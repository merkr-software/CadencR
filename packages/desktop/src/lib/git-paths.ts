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

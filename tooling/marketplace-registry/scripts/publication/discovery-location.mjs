import { validPublicationRepository } from "./plan.mjs";

export const DISCOVERY_FILENAME = "managed-index.json";
export const MAX_DISCOVERY_BYTES = 1024 * 1024;

export function validateDiscoveryBranch(branch) {
  if (typeof branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(branch)) {
    throw new Error("discovery branch is invalid");
  }
  return branch;
}

export function discoveryUrl(repository, branch) {
  if (!validPublicationRepository(repository)) throw new Error("discovery repository is invalid");
  validateDiscoveryBranch(branch);
  return `https://raw.githubusercontent.com/${repository}/refs/heads/${branch}/${DISCOVERY_FILENAME}`;
}

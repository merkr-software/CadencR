// Bind an operator request's delta to the reviewed administrative history.
// Signature and semantic validation remain the qualified Rust publisher's job.
const { existsSync, lstatSync, readFileSync } = require("node:fs");
const { isDeepStrictEqual } = require("node:util");

function readJson(file, limit) {
  if (
    typeof file !== "string" ||
    !file ||
    file.startsWith("/") ||
    file.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("administrative input must be a checkout-relative regular file");
  }
  const parts = file.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const metadata = lstatSync(parts.slice(0, i).join("/"));
    if (
      metadata.isSymbolicLink() ||
      (i < parts.length ? !metadata.isDirectory() : !metadata.isFile())
    ) {
      throw new Error("administrative input must not traverse symlinks");
    }
    if (i === parts.length && metadata.size > limit)
      throw new Error("administrative input exceeds size limit");
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function confirmHandoffs(request) {
  const delta = request.provider_handoffs ?? [];
  let previous = [];
  if (request.previous_index !== "bootstrap") {
    const baseline = readJson(request.previous_index, 32 * 1024 * 1024);
    if (!baseline?.signed || typeof baseline.signed !== "object" || Array.isArray(baseline.signed))
      throw new Error("previous index must contain a signed payload object");
    previous = baseline.signed.provider_handoffs ?? [];
  }
  if (!Array.isArray(delta) || !Array.isArray(previous))
    throw new Error("handoff history and delta must be arrays");
  if (request.discovery_branch !== "marketplace-v2-admin") {
    if (delta.length || previous.length)
      throw new Error("administrative handoffs require the administrative channel");
    return;
  }
  const reviewed = existsSync("provider-handoffs.json")
    ? readJson("provider-handoffs.json", 1024 * 1024)
    : [];
  if (!Array.isArray(reviewed) || !isDeepStrictEqual([...previous, ...delta], reviewed)) {
    throw new Error(
      "publication history plus handoff delta differs from reviewed administrative records",
    );
  }
}

module.exports = { confirmHandoffs };

#!/bin/sh
# Trusted exact-commit CI helper for the unattended catalog and revocation
# policy renewal, the read-only expiry watch and the signing-key lifecycle of
# the reviewed publisher. It contains orchestration and guards only: signing,
# verification and publication are done by the pinned released Rust CLI.
#
#   gate <renewal|watch>             inert-until-configured check (no secrets)
#   fetch <dir> <catalog|policies|all>  bounded, redirect-free public downloads
#   prepare <snapshot> <request>     build the renewal-only request (no secrets)
#   publish <request> <state>        re-assert renewal-only, then publish
#   prepare-policies <snapshot> <work>  plan which revocation policies are due (no secrets)
#   renew-policies <work>            renew and publish each planned policy
#   bootstrap-check                  confirmation + configuration check of the first policy publication (no secrets)
#   bootstrap-policies <work>        sign and bootstrap-publish each missing, EMPTY revocation policy
#   materialize-key <prefix>         write the signing key to an owned 0700 directory
#   remove-key <prefix>              delete it again (shared with the reviewed publisher)
#   check-expiry <snapshot>          expiry + signature checks (watch)
#
# Every error is fatal. Configuration is read from CADENCR_REGISTRY_* variables.
set -eu
mode=${1:?mode is required}
FEED_PREFIX="https://raw.githubusercontent.com/"
MAX_FEED_BYTES=33554432
# Renewal policy, defined once for every mode and every embedded script.
# Renew when at most 8 days (192 hours) of validity remain; the new window is
# 13 days, one day inside the 14-day maximum of the catalog and the policies.
RENEW_WITHIN_HOURS=192
WINDOW_DAYS=13
# The revocation policy feeds as kind:URL variable:file on the discovery
# branch, in this order. The catalog is managed-index.json.
POLICY_FEEDS="provider:CADENCR_REGISTRY_PROVIDER_BLOCKLIST_URL:managed-blocklist.json theme:CADENCR_REGISTRY_THEME_BLOCKLIST_URL:managed-theme-blocklist.json tab:CADENCR_REGISTRY_TAB_BLOCKLIST_URL:managed-tab-blocklist.json"
# LSP is opt-in until the independent signed policy is deployed.
if [ -n "${CADENCR_REGISTRY_LSP_BLOCKLIST_URL:-}" ]; then
  POLICY_FEEDS="$POLICY_FEEDS lsp:CADENCR_REGISTRY_LSP_BLOCKLIST_URL:managed-lsp-blocklist.json"
fi
CATALOG_FILE=managed-index.json
export RENEW_WITHIN_HOURS WINDOW_DAYS POLICY_FEEDS CATALOG_FILE

fail() { echo "::error::$*" >&2; exit 1; }
have() { [ -n "$(printenv "$1" || true)" ]; }

# Split one POLICY_FEEDS entry into $kind, $var and $file.
split_feed() {
  kind=${1%%:*}; rest=${1#*:}; var=${rest%%:*}; file=${rest#*:}
}

# What every embedded script shares: the renewal policy above, the feed table,
# canonical timestamps and the shape of a raw feed URL.
js_common() {
  cat <<'JS'
const RENEW_WITHIN_HOURS = Number(process.env.RENEW_WITHIN_HOURS);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS);
const CATALOG_FILE = process.env.CATALOG_FILE;
const FEEDS = process.env.POLICY_FEEDS.split(" ").map((entry) => {
  const [kind, variable, file] = entry.split(":");
  return { kind, variable, file };
});
const BRANCH = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
// [url, "owner/repo", branch] of a raw refs/heads/<branch>/<file> URL, or null.
const feedUrl = (value, file) => new RegExp(
  `^https://raw\\.githubusercontent\\.com/([^/]+/[^/]+)/refs/heads/(${BRANCH})/${file.replace(/\./g, "\\.")}$`,
).exec(value ?? "");
JS
}

# The shared guard of the first publication of the revocation policies: the
# operator's confirmation, the pinned public identity and, when configured, the
# three policy URLs, which must name this repository's fixed discovery branch.
js_bootstrap() {
  cat <<'JS'
const CONFIRMATION = "bootstrap-empty-policies";
const BOOTSTRAP_BRANCH = "marketplace-v2";
function bootstrapGuard(env) {
  const fail = (message) => { throw new Error(`policy bootstrap guard: ${message}`); };
  if (env.CONFIRM_BOOTSTRAP !== CONFIRMATION) fail(`the confirmation input must be exactly ${CONFIRMATION}`);
  for (const name of ["GITHUB_REPOSITORY", "CADENCR_REGISTRY_KEY_ID", "CADENCR_REGISTRY_PUBLIC_KEY_PEM"]) {
    if (!env[name]) fail(`${name} is required`);
  }
  // The policy URLs are optional here (the catalog may not exist yet), but a
  // configured one must be this repository's own file on the fixed branch.
  for (const { variable, file } of FEEDS) {
    if (!env[variable]) continue;
    const url = feedUrl(env[variable], file) ?? fail(`${variable} must be this repository's raw refs/heads/${BOOTSTRAP_BRANCH}/${file}`);
    if (url[1].toLowerCase() !== env.GITHUB_REPOSITORY.toLowerCase()) fail(`${variable} names a different repository`);
    if (url[2] !== BOOTSTRAP_BRANCH) fail(`${variable} must name the discovery branch ${BOOTSTRAP_BRANCH}`);
  }
}
JS
}

# Run the script on stdin after the shared prelude, in one scope.
node_script() { { js_common; cat; } | node; }
node_bootstrap_script() { { js_common; js_bootstrap; cat; } | node; }

fetch_feed() { # url destination
  case "$1" in
    "$FEED_PREFIX"*) ;;
    *) fail "feed URL must start with $FEED_PREFIX" ;;
  esac
  case "$1" in
    *[!A-Za-z0-9._:/-]*) fail "feed URL contains unsupported characters (no query, fragment or credentials)" ;;
  esac
  [ ! -e "$2" ] || fail "refusing to overwrite $2"
  # No redirects, https only, bounded size and time. A transient 5xx or timeout
  # is retried; anything else (404, redirect, oversize) is terminal. Without
  # --location curl exits 0 on a 3xx, so HTTP 200 is required explicitly.
  status=$(curl --silent --show-error --fail --proto '=https' --max-redirs 0 \
    --max-filesize "$MAX_FEED_BYTES" --max-time 30 \
    --retry 3 --retry-delay 5 --retry-max-time 90 \
    -H 'Cache-Control: no-cache' --output "$2" --write-out '%{http_code}' "$1") \
    || { rm -f "$2"; fail "could not download $1"; }
  [ "$status" = 200 ] || { rm -f "$2"; fail "unexpected HTTP status $status from $1"; }
  # --max-filesize only trusts Content-Length; bound the bytes actually written.
  size=$(wc -c < "$2")
  [ "$size" -le "$MAX_FEED_BYTES" ] || { rm -f "$2"; fail "download from $1 exceeds $MAX_FEED_BYTES bytes"; }
  [ -s "$2" ] || fail "empty download from $1"
}

case "$mode" in
gate)
  purpose=${2:?gate purpose is required}
  case "$purpose" in
    renewal|watch) ;;
    *) fail "unknown gate purpose: $purpose" ;;
  esac
  # Both purposes need every feed plus the pinned key.
  required="CADENCR_REGISTRY_CATALOG_URL"
  for feed in $POLICY_FEEDS; do split_feed "$feed"; required="$required $var"; done
  required="$required CADENCR_REGISTRY_KEY_ID CADENCR_REGISTRY_PUBLIC_KEY_PEM"
  if ! have CADENCR_REGISTRY_CATALOG_URL; then
    echo "::notice title=Registry $purpose is not configured::CADENCR_REGISTRY_CATALOG_URL is unset, so this job is inert. Set the repository variables listed in OPERATIONS.md to activate it."
    echo "configured=false" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  # The catalog URL is the activation switch: from here on, any gap is an error.
  missing=
  for name in $required; do have "$name" || missing="$missing $name"; done
  [ -z "$missing" ] || fail "registry $purpose is partially configured; missing repository variables:$missing"
  trust=0
  for name in CADENCR_REGISTRY_TRUST_MANIFEST_JSON CADENCR_REGISTRY_ROOT_KEY_ID CADENCR_REGISTRY_ROOT_PUBLIC_KEY_PEM; do
    ! have "$name" || trust=$((trust + 1))
  done
  [ "$trust" -eq 0 ] || [ "$trust" -eq 3 ] || fail "trust manifest, root key id and root public key must be configured together"
  echo "configured=true" >> "$GITHUB_OUTPUT"
  ;;

fetch)
  dir=${2:?snapshot directory is required}
  scope=${3:?scope is required}
  case "$scope" in catalog|policies|all) ;; *) fail "unknown fetch scope: $scope" ;; esac
  mkdir -m 700 "$dir"
  case "$scope" in
    catalog|all) fetch_feed "$CADENCR_REGISTRY_CATALOG_URL" "$dir/$CATALOG_FILE" ;;
  esac
  case "$scope" in
    policies|all)
      for feed in $POLICY_FEEDS; do
        split_feed "$feed"
        fetch_feed "$(printenv "$var" || true)" "$dir/$file"
      done
      ;;
  esac
  ;;

prepare)
  SNAPSHOT_DIR=${2:?snapshot directory is required}
  REQUEST_DIR=${3:?request directory is required}
  export SNAPSHOT_DIR REQUEST_DIR
  node_script <<'NODE'
  const { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const env = process.env;
  const fail = (message) => { throw new Error(message); };

  const repository = env.GITHUB_REPOSITORY ?? fail("GITHUB_REPOSITORY is required");
  const url = feedUrl(env.CADENCR_REGISTRY_CATALOG_URL, CATALOG_FILE);
  if (!url) fail("CADENCR_REGISTRY_CATALOG_URL must be this repository's raw refs/heads/<branch>/managed-index.json");
  if (url[1].toLowerCase() !== repository.toLowerCase()) fail("catalog URL names a different repository");
  const branch = url[2];

  const file = join(env.SNAPSHOT_DIR, CATALOG_FILE);
  const metadata = lstatSync(file);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 32 * 1024 * 1024) {
    fail("downloaded catalog must be a bounded regular file");
  }
  const baseline = readFileSync(file);
  // Timestamps and schema only schedule the renewal. The released CLI
  // authenticates this exact file against the pinned public key before signing.
  const signed = JSON.parse(baseline.toString("utf8"))?.signed;
  if (!signed || typeof signed !== "object") fail("downloaded catalog has no signed payload");
  const schema = signed.schema_version;
  if (schema !== 1 && schema !== 2) fail("downloaded catalog has an unsupported schema version");
  if ((schema === 2) !== (branch === "marketplace-v2")) fail("catalog schema does not match its discovery branch");
  if (![signed.generated_at, signed.expires_at].every((v) => TIMESTAMP.test(v ?? ""))) {
    fail("downloaded catalog has non-canonical timestamps");
  }
  const now = Math.floor(Date.now() / 1000) * 1000;
  const remaining = (Date.parse(signed.expires_at) - now) / 3600000;
  if (remaining > RENEW_WITHIN_HOURS) {
    console.log(`::notice title=Catalog renewal not needed::${remaining.toFixed(1)} hours of validity remain (renewal starts at ${RENEW_WITHIN_HOURS}).`);
    appendFileSync(env.GITHUB_OUTPUT, "needed=false\n");
    process.exit(0);
  }
  if (now <= Date.parse(signed.generated_at)) fail("current catalog generation is not older than now; refusing");

  mkdirSync(env.REQUEST_DIR, { recursive: false, mode: 0o700 });
  const put = (name, content) => writeFileSync(join(env.REQUEST_DIR, name), content, { flag: "wx", mode: 0o600 });
  const pem = (value) => (value.endsWith("\n") ? value : value + "\n");
  put("previous-index.json", baseline);
  put("public.pem", pem(env.CADENCR_REGISTRY_PUBLIC_KEY_PEM));
  const request = {
    schema_version: schema,
    repository,
    key_id: env.CADENCR_REGISTRY_KEY_ID,
    discovery_branch: branch,
    generated_at: iso(now),
    expires_at: iso(now + WINDOW_DAYS * 24 * 3600 * 1000),
    previous_index: "previous-index.json",
    public_key: "public.pem",
  };
  if (env.CADENCR_REGISTRY_TRUST_MANIFEST_JSON) {
    const manifest = env.CADENCR_REGISTRY_TRUST_MANIFEST_JSON;
    if (Buffer.byteLength(manifest) > 64 * 1024) fail("trust manifest exceeds 64 KiB");
    JSON.parse(manifest);
    const minimum = Number(env.CADENCR_REGISTRY_TRUST_MIN_GENERATION || "1");
    if (!Number.isSafeInteger(minimum) || minimum < 1) fail("trust minimum generation must be a positive integer");
    put("trust-manifest.json", manifest);
    put("root-public.pem", pem(env.CADENCR_REGISTRY_ROOT_PUBLIC_KEY_PEM));
    request.trust = {
      manifest: "trust-manifest.json",
      root_public_key: "root-public.pem",
      root_key_id: env.CADENCR_REGISTRY_ROOT_KEY_ID,
      minimum_generation: minimum,
    };
  }
  // The renewal-only marker: no package, no submission, no mirror, no upgrade.
  request.publications = [];
  put("publication-request.json", JSON.stringify(request, null, 2) + "\n");
  console.log(`Renewal request: ${request.generated_at} to ${request.expires_at}, baseline had ${remaining.toFixed(1)} hours left.`);
  appendFileSync(env.GITHUB_OUTPUT, "needed=true\n");
NODE
  ;;

publish)
  REQUEST_DIR=${2:?request directory is required}
  STATE_DIR=${3:?state directory is required}
  export REQUEST_DIR STATE_DIR
  node <<'NODE'
  const { spawnSync } = require("node:child_process");
  const { createHash } = require("node:crypto");
  const { lstatSync, mkdirSync, readFileSync, readdirSync } = require("node:fs");
  const { join } = require("node:path");
  const env = process.env;
  const fail = (message) => { throw new Error(`renewal-only guard: ${message}`); };

  // Fail closed unless the request can only re-sign the authenticated baseline.
  function renewalOnlyDigest(directory) {
    const allowed = new Set([
      "publication-request.json", "previous-index.json", "public.pem",
      "trust-manifest.json", "root-public.pem",
    ]);
    for (const name of readdirSync(directory)) {
      if (!allowed.has(name)) fail(`unexpected input ${JSON.stringify(name)}`);
      const metadata = lstatSync(join(directory, name));
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 32 * 1024 * 1024) {
        fail(`${name} must be a bounded regular file`);
      }
    }
    const bytes = readFileSync(join(directory, "publication-request.json"));
    if (bytes.length > 1024 * 1024) fail("request exceeds 1 MiB");
    const request = JSON.parse(bytes.toString("utf8"));
    const base = ["schema_version", "repository", "key_id", "discovery_branch", "generated_at",
      "expires_at", "previous_index", "public_key", "publications"];
    const keys = Object.keys(request).filter((key) => key !== "trust").sort();
    if (JSON.stringify(keys) !== JSON.stringify([...base].sort())) fail("unexpected or missing request fields");
    if (!Array.isArray(request.publications) || request.publications.length !== 0) fail("publications must be empty");
    if (request.previous_index !== "previous-index.json" || request.public_key !== "public.pem") fail("baseline inputs are fixed");
    if (request.repository !== env.GITHUB_REPOSITORY) fail("request names a different repository");
    const window = Date.parse(request.expires_at) - Date.parse(request.generated_at);
    if (!(window > 0 && window <= 14 * 24 * 3600 * 1000)) fail("validity window is outside 14 days");
    if (request.trust !== undefined) {
      const trust = request.trust;
      if (JSON.stringify(Object.keys(trust).sort()) !== JSON.stringify(["manifest", "minimum_generation", "root_key_id", "root_public_key"])
        || trust.manifest !== "trust-manifest.json" || trust.root_public_key !== "root-public.pem") fail("trust inputs are fixed");
    } else if (readdirSync(directory).some((name) => name === "trust-manifest.json" || name === "root-public.pem")) {
      fail("trust files without a trust object");
    }
    return createHash("sha256").update(bytes).digest("hex");
  }

  const digest = renewalOnlyDigest(env.REQUEST_DIR);
  for (const name of ["VERIFIED_CLI", "PRIVATE_KEY_FILE", "GITHUB_SHA"]) if (!env[name]) fail(`${name} is required`);
  mkdirSync(env.STATE_DIR, { recursive: false, mode: 0o700 });
  // The CLI re-hashes the request bytes and refuses any change after this guard.
  const result = spawnSync(env.VERIFIED_CLI, ["registry", "publish-registry",
    "--request", join(env.REQUEST_DIR, "publication-request.json"),
    "--directory", env.STATE_DIR,
    "--repository", env.GITHUB_REPOSITORY,
    "--registry-commit", env.GITHUB_SHA,
    "--private-key", env.PRIVATE_KEY_FILE,
    "--confirm-request-sha256", digest,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("registry renewal failed");
NODE
  ;;

prepare-policies)
  # Plan only, no secrets: decide from the downloaded public bytes which of the
  # three revocation policies are due. Timestamps only schedule; the released CLI
  # authenticates each baseline against the pinned public key before signing.
  # Every policy lives on the catalog's own discovery branch of this repository.
  SNAPSHOT_DIR=${2:?snapshot directory is required}
  POLICY_DIR=${3:?policy work directory is required}
  export SNAPSHOT_DIR POLICY_DIR
  node_script <<'NODE'
  const { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const env = process.env;
  const fail = (message) => { throw new Error(message); };
  const MAX_POLICY_BYTES = 1024 * 1024 + 1024;
  const repository = env.GITHUB_REPOSITORY ?? fail("GITHUB_REPOSITORY is required");
  const catalog = feedUrl(env.CADENCR_REGISTRY_CATALOG_URL, CATALOG_FILE)
    ?? fail("CADENCR_REGISTRY_CATALOG_URL must be this repository's raw refs/heads/<branch>/managed-index.json");
  if (catalog[1].toLowerCase() !== repository.toLowerCase()) fail("catalog URL names a different repository");
  const now = Math.floor(Date.now() / 1000) * 1000;
  const due = [];
  for (const { kind, variable, file } of FEEDS) {
    const url = feedUrl(env[variable], file)
      ?? fail(`${variable} must be this repository's raw refs/heads/<branch>/${file}`);
    if (url[1].toLowerCase() !== repository.toLowerCase()) fail(`${variable} names a different repository`);
    if (url[2] !== catalog[2]) fail(`${variable} must name the catalog's discovery branch ${catalog[2]}`);
    const path = join(env.SNAPSHOT_DIR, file);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_POLICY_BYTES) {
      fail(`downloaded ${kind} policy must be a bounded regular file`);
    }
    const signed = JSON.parse(readFileSync(path, "utf8"))?.signed;
    if (!signed || typeof signed !== "object") fail(`downloaded ${kind} policy has no signed payload`);
    if (![signed.generated_at, signed.expires_at].every((v) => TIMESTAMP.test(v ?? ""))) {
      fail(`downloaded ${kind} policy has non-canonical timestamps`);
    }
    const remaining = (Date.parse(signed.expires_at) - now) / 3600000;
    if (remaining > RENEW_WITHIN_HOURS) {
      console.log(`::notice title=Policy renewal not needed::${kind} policy has ${remaining.toFixed(1)} hours of validity left (renewal starts at ${RENEW_WITHIN_HOURS}).`);
      continue;
    }
    if (now <= Date.parse(signed.generated_at)) fail(`current ${kind} policy generation is not older than now; refusing`);
    due.push({ kind, file, branch: url[2] });
    console.log(`${kind} policy is due: ${remaining.toFixed(1)} hours left.`);
  }
  if (due.length === 0) {
    appendFileSync(env.GITHUB_OUTPUT, "needed=false\n");
    process.exit(0);
  }
  mkdirSync(env.POLICY_DIR, { recursive: false, mode: 0o700 });
  const pem = env.CADENCR_REGISTRY_PUBLIC_KEY_PEM;
  writeFileSync(join(env.POLICY_DIR, "public.pem"), pem.endsWith("\n") ? pem : pem + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(join(env.POLICY_DIR, "plan.json"), JSON.stringify({ policies: due }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  appendFileSync(env.GITHUB_OUTPUT, "needed=true\n");
NODE
  ;;

renew-policies)
  # Holds the signing key and publication token. Re-asserts the plan, then for
  # each due policy: reads the baseline through the authenticated API (the CDN
  # that scheduled the renewal can lag), renews it with the token stripped from
  # the signer's environment, and publishes it in renewal mode, which refuses
  # unless the branch still holds exactly the renewed entries. A policy is never
  # bootstrapped here and never rolled back: the CLI refuses both. Policies are
  # independent; every failure is reported and the step fails at the end.
  POLICY_DIR=${2:?policy work directory is required}
  export POLICY_DIR
  node_script <<'NODE'
  const { spawnSync } = require("node:child_process");
  const { lstatSync, readFileSync, readdirSync } = require("node:fs");
  const { join } = require("node:path");
  const env = process.env;
  const fail = (message) => { throw new Error(`policy renewal guard: ${message}`); };
  const files = Object.fromEntries(FEEDS.map(({ kind, file }) => [kind, file]));
  for (const name of ["VERIFIED_CLI", "PRIVATE_KEY_FILE", "GITHUB_REPOSITORY", "CADENCR_REGISTRY_KEY_ID", "CADENCR_REGISTRY_GITHUB_TOKEN"]) {
    if (!env[name]) fail(`${name} is required`);
  }
  const catalog = feedUrl(env.CADENCR_REGISTRY_CATALOG_URL, CATALOG_FILE)
    ?? fail("CADENCR_REGISTRY_CATALOG_URL must be this repository's raw refs/heads/<branch>/managed-index.json");
  // An older pinned CLI cannot renew policies; say so instead of failing obscurely.
  const help = (command) => spawnSync(env.VERIFIED_CLI, ["registry", command, "--help"], { encoding: "utf8", timeout: 30000 });
  for (const [command, flag] of [["fetch-policy"], ["renew-policy"], ["publish-policy", "--renewal"]]) {
    const result = help(command);
    const lacks = result.error || result.status !== 0 ? command
      : flag && !result.stdout.includes(flag) ? `${command} ${flag}` : "";
    if (lacks) fail(`the pinned released CLI lacks registry ${lacks}; update ci/released-cli.env to a release that includes it`);
  }
  for (const name of readdirSync(env.POLICY_DIR)) {
    if (name !== "plan.json" && name !== "public.pem") fail(`unexpected input ${JSON.stringify(name)}`);
    const metadata = lstatSync(join(env.POLICY_DIR, name));
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 64 * 1024) fail(`${name} must be a bounded regular file`);
  }
  const plan = JSON.parse(readFileSync(join(env.POLICY_DIR, "plan.json"), "utf8"));
  if (JSON.stringify(Object.keys(plan)) !== '["policies"]' || !Array.isArray(plan.policies) || plan.policies.length < 1 || plan.policies.length > FEEDS.length) {
    fail("unexpected plan shape");
  }
  const seen = new Set();
  for (const entry of plan.policies) {
    if (JSON.stringify(Object.keys(entry)) !== '["kind","file","branch"]'
      || files[entry.kind] !== entry.file || seen.has(entry.kind)
      || entry.branch !== catalog[2]) fail("unexpected plan entry");
    seen.add(entry.kind);
  }
  const failures = [];
  // The signer never needs the publication token.
  const { CADENCR_REGISTRY_GITHUB_TOKEN: _token, ...tokenless } = env;
  const cli = (args, environment = env) => spawnSync(env.VERIFIED_CLI, ["registry", ...args], { stdio: "inherit", env: environment });
  const succeeded = (result) => !result.error && result.status === 0;
  for (const { kind, branch } of plan.policies) {
    const baseline = join(env.POLICY_DIR, `${kind}-baseline.json`);
    const renewed = join(env.POLICY_DIR, `${kind}-renewed.json`);
    const keys = ["--public-key", join(env.POLICY_DIR, "public.pem"), "--key-id", env.CADENCR_REGISTRY_KEY_ID];
    const expires = iso(Math.floor(Date.now() / 1000) * 1000 + WINDOW_DAYS * 24 * 3600 * 1000);
    console.log(`::group::Renew ${kind} policy`);
    const ok = succeeded(cli(["fetch-policy", "--kind", kind, "--repository", env.GITHUB_REPOSITORY,
        "--discovery-branch", branch, "--output", baseline]))
      && succeeded(cli(["renew-policy", "--kind", kind, "--current", baseline, ...keys,
        "--private-key", env.PRIVATE_KEY_FILE, "--expires-at", expires, "--output", renewed], tokenless))
      && succeeded(cli(["publish-policy", "--kind", kind, "--signed", renewed, "--repository", env.GITHUB_REPOSITORY,
        "--discovery-branch", branch, ...keys, "--renewal", "--receipt", join(env.POLICY_DIR, `${kind}-receipt.json`)]));
    console.log("::endgroup::");
    if (!ok) {
      console.log(`::error title=Policy renewal failed::the ${kind} policy could not be renewed and published`);
      failures.push(kind);
    }
  }
  if (failures.length > 0) throw new Error(`policy renewal failed for: ${failures.join(", ")}`);
NODE
  ;;

bootstrap-check)
  # No secrets: refuse a wrong confirmation or configuration before the
  # reviewed environment is ever asked for approval.
  node_bootstrap_script <<'NODE'
  bootstrapGuard(process.env);
NODE
  ;;

bootstrap-policies)
  # Holds the signing key and publication token. The FIRST publication of the
  # three revocation policies, each EMPTY (no entries), signed here with the
  # pinned online key and published with `--bootstrap`. A policy already on the
  # branch is skipped, never replaced: the release CLI also refuses `--bootstrap`
  # when the file exists, so a failed or ambiguous existence check cannot
  # overwrite anything. Entries are never set here; the same validity window as a
  # renewal. Policies are independent; every failure is reported and the step
  # fails at the end, so a rerun finishes the missing ones.
  POLICY_DIR=${2:?policy work directory is required}
  export POLICY_DIR
  node_bootstrap_script <<'NODE'
  const { spawnSync } = require("node:child_process");
  const { mkdirSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const env = process.env;
  const fail = (message) => { throw new Error(`policy bootstrap guard: ${message}`); };
  bootstrapGuard(env);
  for (const name of ["VERIFIED_CLI", "PRIVATE_KEY_FILE", "CADENCR_REGISTRY_GITHUB_TOKEN"]) {
    if (!env[name]) fail(`${name} is required`);
  }
  // An older pinned CLI cannot bootstrap policies; say so instead of failing obscurely.
  const help = (command) => spawnSync(env.VERIFIED_CLI, ["registry", command, "--help"], { encoding: "utf8", timeout: 30000 });
  const needed = [["fetch-policy"], ["publish-policy", "--bootstrap"]];
  for (const { kind } of FEEDS) needed.push([`sign-${kind}-blocklist`], [`verify-${kind}-blocklist`]);
  for (const [command, flag] of needed) {
    const result = help(command);
    const lacks = result.error || result.status !== 0 ? command
      : flag && !result.stdout.includes(flag) ? `${command} ${flag}` : "";
    if (lacks) fail(`the pinned released CLI lacks registry ${lacks}; update ci/released-cli.env to a release that includes it`);
  }
  mkdirSync(env.POLICY_DIR, { recursive: false, mode: 0o700 });
  const publicKey = join(env.POLICY_DIR, "public.pem");
  const pem = env.CADENCR_REGISTRY_PUBLIC_KEY_PEM;
  writeFileSync(publicKey, pem.endsWith("\n") ? pem : pem + "\n", { flag: "wx", mode: 0o600 });
  // The signer and the verifier never need the publication token.
  const { CADENCR_REGISTRY_GITHUB_TOKEN: _token, ...tokenless } = env;
  const cli = (args, options = {}) => spawnSync(env.VERIFIED_CLI, ["registry", ...args], { stdio: "inherit", ...options });
  const succeeded = (result) => !result.error && result.status === 0;
  const keys = ["--public-key", publicKey, "--key-id", env.CADENCR_REGISTRY_KEY_ID];
  const target = ["--repository", env.GITHUB_REPOSITORY, "--discovery-branch", BOOTSTRAP_BRANCH];
  const failures = [];
  for (const { kind } of FEEDS) {
    const published = join(env.POLICY_DIR, `${kind}-published.json`);
    const payload = join(env.POLICY_DIR, `${kind}-payload.json`);
    const signed = join(env.POLICY_DIR, `${kind}-signed.json`);
    console.log(`::group::Bootstrap ${kind} policy`);
    // Read through the authenticated API, not the CDN. Success means a policy
    // is already published; failure means absent or unreadable, and the
    // bootstrap below is then the authority (it refuses an existing policy).
    const existing = cli(["fetch-policy", "--kind", kind, ...target, "--output", published],
      { stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" });
    let ok;
    if (succeeded(existing)) {
      console.log(`::notice title=Policy already published::the ${kind} policy already exists on ${BOOTSTRAP_BRANCH}; it is left as is.`);
      ok = true;
    } else {
      const reason = String(existing.stderr ?? "").split("\n")[0].replace(/[^\x20-\x7e]/g, " ").slice(0, 200);
      console.log(`::notice title=Bootstrapping policy::the ${kind} policy was not readable on ${BOOTSTRAP_BRANCH}${reason ? ` (${reason})` : ""}; publishing it with --bootstrap, which refuses an existing policy.`);
      const now = Math.floor(Date.now() / 1000) * 1000;
      // The provider policy has no `kind`; the theme and tab policies carry theirs.
      const document = {
        schema_version: 1,
        ...(kind === "provider" ? {} : { kind: `${kind}-blocklist` }),
        generated_at: iso(now),
        expires_at: iso(now + WINDOW_DAYS * 24 * 3600 * 1000),
        entries: [],
      };
      writeFileSync(payload, JSON.stringify(document, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      ok = succeeded(cli([`sign-${kind}-blocklist`, "--payload", payload, "--private-key", env.PRIVATE_KEY_FILE,
          "--key-id", env.CADENCR_REGISTRY_KEY_ID, "--output", signed], { env: tokenless }))
        && succeeded(cli([`verify-${kind}-blocklist`, "--index", signed, ...keys], { env: tokenless }))
        && succeeded(cli(["publish-policy", "--kind", kind, "--signed", signed, ...target, ...keys, "--bootstrap",
          "--receipt", join(env.POLICY_DIR, `${kind}-receipt.json`)]));
    }
    console.log("::endgroup::");
    if (!ok) {
      console.log(`::error title=Policy bootstrap failed::the ${kind} policy could not be signed and published`);
      failures.push(kind);
    }
  }
  if (failures.length > 0) throw new Error(`policy bootstrap failed for: ${failures.join(", ")}`);
NODE
  ;;

materialize-key)
  # The directory prefix names the workflow that owns the key (for example
  # marketplace-publisher-secret- or marketplace-renewal-secret-).
  KEY_PREFIX=${2:?key directory prefix is required}
  export KEY_PREFIX
  node <<'NODE'
  const { appendFileSync, chmodSync, mkdtempSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  if (!/^marketplace-[a-z]+-secret-$/.test(process.env.KEY_PREFIX)) throw new Error("unsupported private-key directory prefix");
  const key = process.env.CADENCR_REGISTRY_PRIVATE_KEY_PEM;
  if (!key) throw new Error("CADENCR_REGISTRY_PRIVATE_KEY_PEM is required");
  if (Buffer.byteLength(key, "utf8") > 16 * 1024) throw new Error("CADENCR_REGISTRY_PRIVATE_KEY_PEM exceeds 16 KiB");
  const directory = mkdtempSync(join(process.env.PRIVATE_KEY_ROOT, process.env.KEY_PREFIX));
  chmodSync(directory, 0o700);
  const file = join(directory, "private.pem");
  appendFileSync(process.env.GITHUB_OUTPUT, `private_key_file=${file}\n`);
  writeFileSync(file, key, { flag: "wx", mode: 0o600 });
NODE
  ;;

remove-key)
  KEY_PREFIX=${2:?key directory prefix is required}
  export KEY_PREFIX
  node <<'NODE'
  const { lstatSync, unlinkSync } = require("node:fs");
  const { dirname, relative, resolve, sep } = require("node:path");
  if (!/^marketplace-[a-z]+-secret-$/.test(process.env.KEY_PREFIX)) throw new Error("unsupported private-key directory prefix");
  const root = resolve(process.env.PRIVATE_KEY_ROOT);
  const file = resolve(process.env.PRIVATE_KEY_FILE);
  const owned = relative(root, file).split(sep);
  if (owned.length !== 2 || !new RegExp(`^${process.env.KEY_PREFIX}[^/]+$`).test(owned[0]) || owned[1] !== "private.pem") {
    throw new Error("refusing to clean a private-key path outside the owned directory");
  }
  try {
    const directoryMetadata = lstatSync(dirname(file));
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new Error("refusing to clean through an unexpected private-key directory");
    }
    const metadata = lstatSync(file);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("refusing to clean an unexpected private-key path");
    unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
NODE
  ;;

check-expiry)
  dir=${2:?snapshot directory is required}
  : "${VERIFIED_CLI:?VERIFIED_CLI is required}"
  : "${KEY_DIR:?KEY_DIR is required}"
  status=0
  # Public key from a repository variable; downloaded bytes are only ever data.
  umask 077
  mkdir "$KEY_DIR"
  printf '%s\n' "$CADENCR_REGISTRY_PUBLIC_KEY_PEM" > "$KEY_DIR/public.pem"
  # Timestamp diagnostic: exit 1 at or below 72 hours, when expired or malformed.
  policy_files=
  for feed in $POLICY_FEEDS; do split_feed "$feed"; policy_files="$policy_files $file"; done
  for name in "$CATALOG_FILE" $policy_files; do
    echo "== expiry: $name"
    "$VERIFIED_CLI" registry check-metadata-expiry --warning-hours 72 "$dir/$name" \
      || { echo "::error title=Registry metadata needs renewal::$name expires within 72 hours, is expired, or is unreadable"; status=1; }
  done
  # The timestamp diagnostic is unauthenticated, so also verify every feed's
  # signature and domain with the released CLI.
  pairs="verify-index:$CATALOG_FILE"
  for feed in $POLICY_FEEDS; do split_feed "$feed"; pairs="$pairs verify-$kind-blocklist:$file"; done
  for pair in $pairs; do
    command=${pair%%:*}; name=${pair#*:}
    echo "== signature: $name"
    "$VERIFIED_CLI" registry "$command" --index "$dir/$name" --public-key "$KEY_DIR/public.pem" \
      --key-id "$CADENCR_REGISTRY_KEY_ID" \
      || { echo "::error title=Registry signature check failed::$name did not verify with the pinned key"; status=1; }
  done
  exit "$status"
  ;;

*) fail "unknown mode: $mode" ;;
esac

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve, sep, dirname, join } from "node:path";
export const REPOSITORY = "merkr-software/cadencr-registry-qa";
export const VERSION = "0.13.1-dev.39108033875.1";
export const BINARY_SHA = "d11bfade6297fa30e1e10e82605f5a221da8e07edeeee372e2c2f6185c6ff725";
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function file(path, max = 4194304) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= max);
  return readFileSync(path);
}
export function local(path) {
  assert.equal(typeof path, "string");
  assert.ok(!path.split(/[\\/]/).includes("..") && !path.startsWith("/"));
  assert.ok(resolve(path).startsWith(process.cwd() + sep));
  return path;
}
export function guard(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REPOSITORY_ID, "1420296872");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.QA_DEFAULT_BRANCH, "main");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.match(env.REVIEWED_COMMIT ?? "", /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_SHA, env.REVIEWED_COMMIT);
  assert.ok(["first", "fresh"].includes(env.QA_RUNNER));
  for (const key of ["REQUEST_SHA256", "PLAN_SHA256"])
    assert.match(env[key] ?? "", /^[a-f0-9]{64}$/);
  const planBytes = file(local(env.QA_PLAN));
  assert.equal(sha(planBytes), env.PLAN_SHA256);
  const plan = JSON.parse(planBytes);
  assert.ok(["incremental", "renewal"].includes(plan.phase));
  const requestBytes = file(local(plan.request));
  assert.equal(sha(requestBytes), env.REQUEST_SHA256);
  const request = JSON.parse(requestBytes);
  assert.equal(request.repository, REPOSITORY);
  assert.equal(request.schema_version, 2);
  assert.equal(request.discovery_branch, "marketplace-v2");
  assert.notEqual(request.previous_index, "bootstrap", "never reset the existing feed");
  assert.equal(sha(file(local(plan.previous))), plan.previous_sha256);
  assert.equal(sha(file(local(plan.public_key))), plan.public_key_sha256);
  assert.equal(resolve(plan.public_key), resolve(dirname(plan.request), request.public_key));
  assert.equal(resolve(plan.previous), resolve(dirname(plan.request), request.previous_index));
  assert.equal(request.key_id, plan.key_id);
  assert.equal(request.publications.length, plan.phase === "renewal" ? 0 : 3);
  for (const publication of request.publications) {
    const path = local(join(dirname(plan.request), publication.submission));
    assert.ok(Object.hasOwn(plan.inputs, path), "every submission must be hash-bound");
  }
  for (const [path, digest] of Object.entries(plan.inputs))
    assert.equal(sha(file(local(path))), digest);
  if (plan.fault) {
    const faultSubmission = local(plan.fault.submission);
    assert.ok(Object.hasOwn(plan.inputs, faultSubmission));
    assert.equal(JSON.parse(file(faultSubmission)).package.kind, "theme");
    assert.ok(plan.mirror_tags.includes(plan.fault.tag));
    const theme = JSON.parse(file(faultSubmission)).package.package.theme;
    assert.equal(plan.fault.tag, `theme-${theme.id}-v${theme.version}`);
  }
  if (env.QA_RUNNER === "fresh")
    assert.match(env.QA_EXPECTED_INVENTORY_SHA256 ?? "", /^[a-f0-9]{64}$/);
  return { plan, request };
}
if (process.argv[1] === new URL(import.meta.url).pathname) guard();

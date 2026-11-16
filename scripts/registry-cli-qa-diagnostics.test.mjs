import test from "node:test";
import assert from "node:assert/strict";
import { failureDiagnostic } from "./registry-cli-qa/evidence.mjs";

test("CLI failure reasons classify only complete allowlisted messages", () => {
  const diagnostic = (message) =>
    failureDiagnostic({
      status: 1,
      stderr: JSON.stringify({
        ok: false,
        code: "REGISTRY_PIPELINE_FAILED",
        message,
        reason: "untrusted-secret",
        http_status: 401,
      }),
    });
  const cases = [
    ["public discovery: convergence read budget exhausted", "discovery_convergence_exhausted"],
    ["public discovery: read budget exhausted", "discovery_read_exhausted"],
    ["GitHub discovery verification deadline exceeded", "discovery_deadline"],
    ["GitHub API request failed", "github_transport"],
    ["GitHub API request failed with status 403", "github_status"],
    ["GitHub API request failed with status 599", "github_status"],
  ];
  for (const [message, reason] of cases) {
    const safe = diagnostic(message);
    assert.equal(safe.reason, reason);
    assert.equal(safe.http_status, reason === "github_status" ? Number(message.slice(-3)) : null);
    assert.match(safe.message_sha256, /^[a-f0-9]{64}$/);
    for (const injected of [
      "token-secret " + message,
      message + " /private/key.pem",
      message + "\n",
      message + " -----BEGIN PRIVATE KEY-----",
    ]) {
      const rejected = diagnostic(injected);
      assert.equal(rejected.reason, null);
      assert.equal(rejected.http_status, null);
      assert.ok(!JSON.stringify(rejected).includes("secret"));
      assert.ok(!JSON.stringify(rejected).includes("/private/"));
      assert.ok(!JSON.stringify(rejected).includes("PRIVATE KEY"));
    }
  }
  for (const status of ["099", "600", "403.0", "4030", "-403", "403 extra", "403\n"]) {
    const safe = diagnostic("GitHub API request failed with status " + status);
    assert.equal(safe.reason, null);
    assert.equal(safe.http_status, null);
  }
  for (const message of ["unknown-secret", "", "GitHub API request failed with status 401 token"]) {
    const safe = diagnostic(message);
    assert.equal(safe.reason, null);
    assert.equal(safe.http_status, null);
    assert.ok(!JSON.stringify(safe).includes("secret"));
  }
});

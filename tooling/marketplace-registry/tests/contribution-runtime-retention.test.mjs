import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const wrapper = new URL("../scripts/ci/validate-provider-contribution.sh", import.meta.url);

for (const [name, bootstrapStatus, validationStatus] of [
  ["success", 0, 0],
  ["validation failure", 0, 17],
  ["bootstrap failure", 23, 0],
]) {
  test(`contribution wrapper retains unexpected state after ${name}`, async () => {
    // Intentionally retained: never recursively clean up executable-owned state,
    // including this fake database sentinel, even in a test fixture.
    const root = await mkdtemp(path.join(os.tmpdir(), "contribution-retention-"));
    const scripts = path.join(root, "scripts");
    await mkdir(scripts);
    const script = path.join(scripts, "validate-provider-contribution.sh");
    await copyFile(wrapper, script);
    await writeFile(
      path.join(scripts, "fetch-released-cli.sh"),
      `#!/bin/sh
set -eu
mkdir "$2"
printf 'retained bootstrap state' > "$2/bootstrap-state.db"
if [ "$BOOTSTRAP_STATUS" -ne 0 ]; then exit "$BOOTSTRAP_STATUS"; fi
cat > "$2/cadencr" <<'CLI'
#!/bin/sh
set -eu
printf 'retained validation state' > "$(dirname "$0")/validation-state.db"
printf '%s\\n' "$@"
exit "$VALIDATION_STATUS"
CLI
chmod 700 "$2/cadencr"
printf '%s\\n' "$2/cadencr"
`,
    );
    const result = spawnSync("/bin/sh", [script, "inert-pin", "base", "candidate", "validate"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        BOOTSTRAP_STATUS: String(bootstrapStatus),
        VALIDATION_STATUS: String(validationStatus),
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, bootstrapStatus || validationStatus, result.stderr);
    const retained = result.stderr.match(/^Registry validation scratch retained at: (.+)$/m)?.[1];
    assert.ok(retained, result.stderr);
    assert.equal(path.dirname(retained), root);
    assert.equal(
      await readFile(path.join(retained, "released/bootstrap-state.db"), "utf8"),
      "retained bootstrap state",
    );
    if (bootstrapStatus === 0) {
      assert.equal(
        await readFile(path.join(retained, "released/validation-state.db"), "utf8"),
        "retained validation state",
      );
      assert.equal(result.stdout, "registry\nvalidate\n--base\nbase\n--candidate\ncandidate\n");
    } else {
      assert.equal(result.stdout, "");
    }
  });
}

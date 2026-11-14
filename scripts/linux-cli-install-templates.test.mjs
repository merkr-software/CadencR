import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const templates = {
  install: readFileSync(
    "packages/desktop/build/linux/after-install.tpl",
    "utf8",
  ),
  remove: readFileSync("packages/desktop/build/linux/after-remove.tpl", "utf8"),
};

// electron-builder (FpmTarget writeConfigFile) throws on any other `${macro}`.
const render = (template) =>
  template.replace(/\${([a-zA-Z]+)}/g, (_match, name) => {
    const values = { executable: "cadencr", sanitizedProductName: "Cadencr" };
    assert.ok(name in values, `undefined electron-builder macro: ${name}`);
    return values[name];
  });

test("DEB and RPM use the command line templates", () => {
  for (const file of ["electron-builder.yml", "electron-builder.local.yml"]) {
    const config = parse(readFileSync(`packages/desktop/${file}`, "utf8"));
    for (const target of ["deb", "rpm"]) {
      assert.equal(
        config[target].afterInstall,
        "build/linux/after-install.tpl",
        `${file} ${target}`,
      );
      assert.equal(
        config[target].afterRemove,
        "build/linux/after-remove.tpl",
        `${file} ${target}`,
      );
    }
    assert.ok(
      config.extraResources.some(
        (entry) =>
          entry.from === "resources/bin/${arch}/cadencr" &&
          entry.to === "bin/cadencr",
      ),
      `${file} bundles the CLI`,
    );
  }
});

test("/usr/bin/cadencr links to the bundled command line, replacing the old Electron link", () => {
  const install = render(templates.install);
  assert.match(
    install,
    /CADENCR_CLI='\/opt\/Cadencr\/resources\/bin\/cadencr'/,
  );
  assert.match(
    install,
    /update-alternatives --remove 'cadencr' '\/opt\/Cadencr\/cadencr'/,
  );
  assert.match(
    install,
    /update-alternatives --install '\/usr\/bin\/cadencr' 'cadencr' "\$CADENCR_CLI" 100/,
  );
  assert.match(
    render(templates.remove),
    /--remove 'cadencr' '\/opt\/Cadencr\/resources\/bin\/cadencr'/,
  );
});

// Runs the rendered after-remove with `argument` as the package manager does,
// against a stub update-alternatives; returns what it was asked to remove.
function removalsFor(argument) {
  const dir = mkdtempSync(join(tmpdir(), "cadencr-after-remove-"));
  try {
    const log = join(dir, "calls");
    writeFileSync(log, "");
    const stub = join(dir, "update-alternatives");
    writeFileSync(stub, `#!/bin/sh\necho "$*" >> '${log}'\n`);
    chmodSync(stub, 0o755);
    const result = spawnSync("bash", ["-s", argument], {
      input: render(templates.remove),
      encoding: "utf8",
      env: { PATH: `${dir}:/usr/bin:/bin` },
    });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(log, "utf8").trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an upgrade keeps the link the new package registered; a removal drops it", () => {
  // RPM: $1 counts the versions left (1 on upgrade, 0 on erase). DEB: a verb.
  for (const upgrade of ["1", "2", "upgrade"]) {
    assert.equal(removalsFor(upgrade), "", `after-remove ${upgrade}`);
  }
  for (const removal of ["0", "remove", "purge"]) {
    assert.equal(
      removalsFor(removal),
      "--remove cadencr /opt/Cadencr/resources/bin/cadencr",
      `after-remove ${removal}`,
    );
  }
});

test("the rest of electron-builder's default scripts is kept", () => {
  const install = render(templates.install);
  for (const kept of [
    "chrome-sandbox",
    "update-desktop-database",
    "update-mime-database",
    "apparmor_parser",
  ]) {
    assert.ok(install.includes(kept), kept);
  }
  assert.ok(render(templates.remove).includes("apparmor_parser --remove"));
});

test("both scripts are valid bash", () => {
  for (const template of Object.values(templates)) {
    const result = spawnSync("bash", ["-n"], {
      input: render(template),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

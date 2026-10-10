import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { electronBundleProblem } from "../packages/desktop/scripts/ensure-electron-lib.mjs";
import { evaluate, formatReport, satisfiesRange } from "./doctor.mjs";

const SERVICE = {
  CADENCR_AUTH_TOKEN: "tok",
  CADENCR_FRONTEND_PORT: "1420",
  CADENCR_RUST_PORT: "5005",
  CADENCR_DB_PATH: "./cadencr.local.db",
};
const DESKTOP = {
  VITE_API_TOKEN: "tok",
  VITE_FRONTEND_PORT: "1420",
  VITE_API_URL: "http://127.0.0.1:5005",
};

function facts(overrides = {}) {
  return {
    node: { version: "22.19.0", range: ">=22.19.0 <23.0.0", nvmrc: "22.19.0" },
    pnpm: { version: "11.1.3", expected: "11.1.3", problem: "" },
    deps: { installed: true },
    rust: { toolchain: "stable-x86_64-unknown-linux-gnu", components: ["rustfmt-x", "clippy-x"] },
    watcher: { tool: "watchexec", path: "/usr/bin/watchexec" },
    env: { service: { ...SERVICE }, desktop: { ...DESKTOP } },
    linkedWorktree: false,
    gitProblem: null,
    electron: { installed: true },
    ...overrides,
  };
}
const problems = (result) => result.filter(({ status }) => status !== "ok");

test("satisfiesRange handles the engines range and alternatives", () => {
  assert.ok(satisfiesRange("22.19.0", ">=22.19.0 <23.0.0"));
  assert.ok(satisfiesRange("v22.23.2", ">=22.19.0 <23.0.0"));
  assert.ok(!satisfiesRange("22.18.0", ">=22.19.0 <23.0.0"));
  assert.ok(!satisfiesRange("23.0.0", ">=22.19.0 <23.0.0"));
  assert.ok(satisfiesRange("20.1.0", ">=22 || 20.1.0"));
  assert.throws(() => satisfiesRange("22.0.0", "^22"), /unsupported/);
});

test("a healthy checkout reports no problems", () => {
  assert.deepEqual(problems(evaluate(facts())), []);
});

test("an old Node is an error that points at .nvmrc auto-switching", () => {
  const [node] = problems(
    evaluate(facts({ node: { version: "22.18.0", range: ">=22.19.0 <23.0.0", nvmrc: "22.19.0" } })),
  );
  assert.equal(node.status, "error");
  assert.match(node.fix, /fnm use|nvm use/);
  assert.match(node.fix, /22\.19\.0/);
});

test("pnpm, toolchain components and watcher problems each carry a fix", () => {
  const result = problems(
    evaluate(
      facts({
        pnpm: { version: "10.0.0", expected: "11.1.3", problem: "" },
        rust: { toolchain: "stable", components: ["rustc-x"] },
        watcher: { tool: null, path: null },
      }),
    ),
  );
  assert.deepEqual(
    result.map(({ status }) => status),
    ["error", "error", "error"],
  );
  assert.match(result[0].fix, /corepack enable/);
  assert.match(result[1].fix, /rustup component add rustfmt clippy/);
  assert.match(result[2].fix, /cargo install watchexec-cli --locked/);
});

test("cargo-watch alone is a warning, not an error", () => {
  const [watcher] = problems(evaluate(facts({ watcher: { tool: "cargo-watch", path: "/c" } })));
  assert.equal(watcher.status, "warn");
  assert.match(watcher.title, /cargo-watch at \/c/);
});

test("missing .env files point to setup:dev, or configure-worktree in a worktree", () => {
  const env = { service: null, desktop: null };
  const main = problems(evaluate(facts({ env })));
  assert.equal(main.length, 2);
  assert.ok(main.every(({ fix }) => fix.includes("pnpm setup:dev")));
  const worktree = problems(evaluate(facts({ env, linkedWorktree: true })));
  assert.ok(worktree.every(({ fix }) => fix.includes("pnpm dev:configure-worktree")));
});

test("token placeholders, token mismatches and port drift are errors", () => {
  const placeholder = problems(
    evaluate(
      facts({
        env: { service: SERVICE, desktop: { ...DESKTOP, VITE_API_TOKEN: "replace-with-x" } },
      }),
    ),
  );
  assert.match(placeholder[0].title, /placeholder/);
  assert.match(placeholder[0].fix, /pnpm setup:dev/);
  const worktreePlaceholder = problems(
    evaluate(
      facts({
        env: { service: { ...SERVICE, CADENCR_AUTH_TOKEN: "" }, desktop: DESKTOP },
        linkedWorktree: true,
      }),
    ),
  ).find(({ title }) => /placeholder/.test(title));
  assert.match(worktreePlaceholder.fix, /pnpm dev:configure-worktree/);
  const mismatch = problems(
    evaluate(
      facts({ env: { service: SERVICE, desktop: { ...DESKTOP, VITE_API_TOKEN: "other" } } }),
    ),
  );
  assert.match(mismatch[0].title, /401/);
  assert.match(mismatch[0].fix, /--fix-token/);
  const ports = problems(
    evaluate(
      facts({
        env: { service: SERVICE, desktop: { ...DESKTOP, VITE_API_URL: "http://127.0.0.1:5100" } },
      }),
    ),
  );
  assert.match(ports[0].title, /CADENCR_RUST_PORT=5005/);
});

test("a service .env missing required keys is an error", () => {
  const service = { ...SERVICE, CADENCR_DB_PATH: "" };
  const [missing] = problems(evaluate(facts({ env: { service, desktop: DESKTOP } })));
  assert.match(missing.title, /CADENCR_DB_PATH/);
});

test("the report lists fixes and totals", () => {
  const report = formatReport([
    { status: "ok", title: "fine" },
    { status: "error", title: "broken", fix: "do x" },
  ]);
  assert.match(report, /error {2}broken\n {9}fix: do x/);
  assert.match(report, /1 error\(s\), 0 warning\(s\)$/);
});

test("a failed git probe is reported as a warning, not swallowed", () => {
  const [git] = problems(evaluate(facts({ gitProblem: "fatal: not a git repository" })));
  assert.equal(git.status, "warn");
  assert.match(git.title, /not a git repository/);
});

test("electronBundleProblem names a missing binary and a broken macOS bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "cadencr-doctor-electron-"));
  try {
    assert.match(
      electronBundleProblem({ electronModulePath: root, platform: "linux" }),
      /not found/,
    );
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "electron"), "");
    assert.equal(electronBundleProblem({ electronModulePath: root, platform: "linux" }), null);
    const macos = join(root, "dist/Electron.app/Contents/MacOS");
    mkdirSync(macos, { recursive: true });
    writeFileSync(join(macos, "Electron"), "");
    assert.match(
      electronBundleProblem({ electronModulePath: root, platform: "darwin" }),
      /incomplete macOS app bundle: .*Electron Framework/,
    );
    const frameworks = join(root, "dist/Electron.app/Contents/Frameworks");
    for (const file of [
      "Electron Framework.framework/Versions/A/Electron Framework",
      "Mantle.framework/Mantle",
      "ReactiveObjC.framework/ReactiveObjC",
      "Squirrel.framework/Squirrel",
    ]) {
      mkdirSync(dirname(join(frameworks, file)), { recursive: true });
      writeFileSync(join(frameworks, file), "");
    }
    assert.match(
      electronBundleProblem({ electronModulePath: root, platform: "darwin" }),
      /Versions\/Current symlink/,
    );
    symlinkSync("A", join(frameworks, "Electron Framework.framework/Versions/Current"));
    assert.equal(electronBundleProblem({ electronModulePath: root, platform: "darwin" }), null);
    assert.match(electronBundleProblem({ electronModulePath: root, platform: "aix" }), /aix/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

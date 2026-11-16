/** Test fixtures: the "Aurora" multi-export plugin (agent + tab + theme) as the signed catalog serves it. */
const REPOSITORY = "https://github.com/acme/aurora";
const sha = "a".repeat(64);
const host = { publisher: "acme", compatibility: { min_app_version: "0.16.0" } };
const archive = (version: string, name: string) =>
  `${REPOSITORY}/releases/download/v${version}/${name}.tar.gz`;

export function auroraAgent(version: string) {
  return {
    kind: "provider" as const,
    package: {
      agent: {
        id: "aurora-agent",
        name: "Aurora agent",
        version,
        description: "An ACP agent",
        license: "MIT",
        repository: REPOSITORY,
        distribution: {
          binary: { "darwin-aarch64": { archive: archive(version, "agent"), cmd: "bin/agent" } },
        },
      },
      host: { ...host, assets: { icon: "icon.svg" } },
    },
  };
}

export function auroraTab(version: string) {
  return {
    kind: "tab" as const,
    package: {
      tab: {
        id: "aurora-tab",
        name: "Aurora tab",
        description: "A workspace tab",
        version,
        repository: REPOSITORY,
        license: "MIT",
        api_version: 1 as const,
        distribution: { archive: archive(version, "tab"), sha256: sha },
      },
      host,
    },
  };
}

export function auroraTheme(version: string) {
  return {
    kind: "theme" as const,
    package: {
      theme: {
        id: "aurora-theme",
        name: "Aurora theme",
        description: "Northern colors",
        version,
        repository: REPOSITORY,
        license: "MIT",
        document_version: 1 as const,
        distribution: { archive: archive(version, "theme"), sha256: sha },
      },
      host,
    },
  };
}

export function auroraPlugin(
  version: string,
  contributes: unknown[] = [auroraAgent(version), auroraTab(version), auroraTheme(version)],
) {
  return {
    kind: "plugin" as const,
    package: {
      plugin: {
        id: "aurora",
        name: "Aurora",
        description: "An agent, a tab and a theme",
        version,
        repository: REPOSITORY,
        license: "MIT",
      },
      host,
      contributes,
    },
  };
}

export function signedCatalog(packages: unknown[]) {
  return {
    signature: { algorithm: "ed25519" as const, key_id: "release", value: "signed-envelope" },
    signed: {
      schema_version: 2 as const,
      generated_at: "2026-10-01T00:00:00Z",
      expires_at: "2099-01-01T00:00:00Z",
      packages,
    },
  };
}

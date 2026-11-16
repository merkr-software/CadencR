import type { Plugin } from "vite";

export interface ElectronBundleContract {
  processName: "main" | "preload";
  entryFileName: string;
  externalizationSentinels: readonly string[];
  /**
   * Extra entries that run as *sandboxed* preloads (notch island, custom-tab
   * guest). A sandboxed preload can `require` only `electron`, never a sibling
   * chunk, so each must exist and import nothing but its sentinels.
   */
  sandboxedEntryFileNames?: readonly string[];
}

interface BundleOutput {
  type: string;
  isEntry?: boolean;
  imports?: readonly string[];
}

export function assertElectronBundleContract(
  contract: ElectronBundleContract,
  outputFormat: string | undefined,
  bundle: Record<string, BundleOutput>,
): void {
  if (outputFormat !== "cjs") {
    throw new Error(
      `Electron ${contract.processName} build must use CommonJS, but received ${outputFormat ?? "no format"}.`,
    );
  }

  const entry = bundle[contract.entryFileName];
  if (entry?.type !== "chunk" || !entry.isEntry) {
    throw new Error(
      `Electron ${contract.processName} build did not produce the required entry: ${contract.entryFileName}`,
    );
  }

  for (const dependency of contract.externalizationSentinels) {
    if (!entry.imports?.includes(dependency)) {
      throw new Error(
        `Electron ${contract.processName} bundle did not keep ${dependency} external; ` +
          "the electron-vite build preset may have been lost.",
      );
    }
  }

  for (const fileName of contract.sandboxedEntryFileNames ?? []) {
    assertSandboxedEntry(contract, fileName, bundle[fileName]);
  }
}

function assertSandboxedEntry(
  contract: ElectronBundleContract,
  fileName: string,
  entry: BundleOutput | undefined,
): void {
  if (entry?.type !== "chunk" || !entry.isEntry) {
    throw new Error(
      `Electron ${contract.processName} build did not produce the required entry: ${fileName}`,
    );
  }
  const local = (entry.imports ?? []).filter(
    (dependency) => !contract.externalizationSentinels.includes(dependency),
  );
  if (local.length > 0) {
    throw new Error(
      `Sandboxed ${contract.processName} entry ${fileName} imports ${local.join(", ")}; ` +
        "a sandboxed preload can only require electron.",
    );
  }
}

export function electronBundleContractPlugin(contract: ElectronBundleContract): Plugin {
  return {
    name: `cadencr-${contract.processName}-bundle-contract`,
    apply: "build",
    generateBundle(outputOptions, bundle) {
      assertElectronBundleContract(contract, outputOptions.format, bundle);
    },
  };
}

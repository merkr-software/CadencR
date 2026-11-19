{
  description = "Cadencr development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    # Keep Intel macOS supported and update this lock alongside .nvmrc.
    nodeNixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
  };

  outputs = { nixpkgs, nodeNixpkgs, ... }:
    let
      nodeVersion = builtins.replaceStrings [ "\n" ] [ "" ] (builtins.readFile ./.nvmrc);
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          nodePkgs = import nodeNixpkgs { inherit system; };
          darwinPackages = pkgs.lib.optionals pkgs.stdenv.isDarwin [
            pkgs.apple-sdk_15
            pkgs.libiconv
          ];
        in
        {
          default = assert nodePkgs.nodejs_22.version == nodeVersion; pkgs.mkShell {
            # pnpm is not listed: corepack_22's shims run the exact version
            # pinned by package.json `packageManager`. The Rust toolchain and
            # its components come from rust-toolchain.toml through rustup.
            packages = with pkgs; [
              git
              openssl
              pkg-config
              python3
              rustup
              sqlite
              watchexec
            ] ++ darwinPackages ++ [ nodePkgs.nodejs_22 nodePkgs.corepack_22 ];

            RUST_SRC_PATH = pkgs.rustPlatform.rustLibSrc;
            COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";

            shellHook = ''
              echo "Cadencr dev shell"
              echo "Node: $(node --version)"
              echo "pnpm: $(pnpm --version)"
              if rustc --version >/dev/null 2>&1; then
                echo "Rust: $(rustc --version)"
              else
                echo "Rust: run 'rustup toolchain install' (reads rust-toolchain.toml)"
              fi
              echo "Next: pnpm install && pnpm setup:dev && pnpm doctor"
            '';
          };
        });
    };
}

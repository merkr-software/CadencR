{
  description = "Cadencr development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
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
          darwinPackages = pkgs.lib.optionals pkgs.stdenv.isDarwin [
            pkgs.apple-sdk_15
            pkgs.libiconv
          ];
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              cargo-watch
              git
              nodejs_22
              openssl
              pkg-config
              pnpm_9
              rustup
              sqlite
            ] ++ darwinPackages;

            RUST_SRC_PATH = pkgs.rustPlatform.rustLibSrc;
            COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";

            shellHook = ''
              echo "Cadencr dev shell"
              echo "Node: $(node --version)"
              echo "pnpm: $(pnpm --version)"
              if rustc --version >/dev/null 2>&1; then
                echo "Rust: $(rustc --version)"
              else
                echo "Rust: install a toolchain with: rustup toolchain install stable --component rustfmt --component clippy"
              fi
            '';
          };
        });
    };
}

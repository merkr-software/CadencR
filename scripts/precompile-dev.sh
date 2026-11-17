#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

node scripts/disk-space.mjs "pnpm dev:precompile"

echo "Precompiling Claude SDK..."
node scripts/cargo-env.mjs cargo build --quiet -p claude-agent-sdk-rs

echo "Precompiling Cadencr service..."
node scripts/cargo-env.mjs cargo build --quiet -p cadencr-service
pnpm --silent --filter @cadencr/service copy:debug

echo "Rust development targets are ready."

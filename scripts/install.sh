#!/usr/bin/env bash
# Installs the Factory at user level: builds the CLI and registers its hooks in
# ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR). Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm run build
node dist/factory.mjs install

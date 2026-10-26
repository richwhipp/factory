#!/usr/bin/env bash
# Setup script for the Factory's Claude Code on the web environment: paste it into the
# environment's setup script. It installs the Factory at user level in the cloud VM.
set -euo pipefail
FACTORY_DIR=/opt/factory
if [ ! -d "$FACTORY_DIR/.git" ]; then
  git clone --depth 1 https://github.com/richwhipp/factory.git "$FACTORY_DIR"
fi
"$FACTORY_DIR/scripts/install.sh"

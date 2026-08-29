#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPILER_DIR="$REPOSITORY_DIR/compiler-experiment"
DEPS_DIR=${PLINTH_COMPILER_DEPS:-"$COMPILER_DIR/.compiler-deps"}
GHC_WASM_PREFIX=${GHC_WASM_PREFIX:-"$DEPS_DIR/ghc-wasm"}
PLINTH_BUILD_TMP=${PLINTH_BUILD_TMP:-"$DEPS_DIR/tmp"}
RUNTIME_DIR=${PLINTH_RUNTIME_DIR:-"$REPOSITORY_DIR/public/runtime"}

export GHC_WASM_PREFIX PLINTH_BUILD_TMP PLINTH_COMPILER_DEPS="$DEPS_DIR"

for command_name in autoreconf git curl jq patch sha256sum tar rsync pigz; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

"$COMPILER_DIR/scripts/bootstrap-compiler.sh"

RUN_TESTS=${RUN_TESTS:-1} \
  "$COMPILER_DIR/build-uplc-ghc-wasm.sh"

"$COMPILER_DIR/build-browser-rootfs.sh"

if [[ ${BUILD_WEB_APP:-1} == 1 ]]; then
  command -v npm >/dev/null 2>&1 || {
    echo "Missing required command: npm" >&2
    exit 1
  }
  cd "$REPOSITORY_DIR"
  npm ci
  npm run lint
  npm run build
  web_build_status="$REPOSITORY_DIR/dist"
else
  web_build_status="skipped (BUILD_WEB_APP=0)"
fi

printf '%s\n' \
  "Source build complete." \
  "Browser runtime: $RUNTIME_DIR" \
  "Web build:       $web_build_status"

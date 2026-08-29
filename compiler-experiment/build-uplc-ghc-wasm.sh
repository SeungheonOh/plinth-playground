#!/usr/bin/env bash
set -euo pipefail

EXPERIMENT_DIR=$(cd "$(dirname "$0")" && pwd)
GHC_WASM_PREFIX=${GHC_WASM_PREFIX:-"$EXPERIMENT_DIR/.compiler-deps/ghc-wasm"}
BUILD_DIR=${PLINTH_COMPILER_BUILD_DIR:-"$EXPERIMENT_DIR/dist-uplc-ghc-wasm-9.12"}
BUILD_TMP_DIR=${PLINTH_BUILD_TMP:-"$EXPERIMENT_DIR/.compiler-deps/tmp"}

[[ -f "$GHC_WASM_PREFIX/env" ]] || {
  echo "Missing GHC WASM toolchain: $GHC_WASM_PREFIX" >&2
  echo "Run ./scripts/bootstrap-compiler.sh first." >&2
  exit 1
}
[[ -f "$EXPERIMENT_DIR/uplc-ghc-wasm-9.12/src/Main.hs" ]] || {
  echo "Missing generated GHC driver source." >&2
  echo "Run ./scripts/bootstrap-compiler.sh first." >&2
  exit 1
}

mkdir -p "$BUILD_TMP_DIR"
export GHC_WASM_PREFIX TMPDIR="$BUILD_TMP_DIR"

# shellcheck disable=SC1090
. "$GHC_WASM_PREFIX/env"

if [[ -n ${HAPPY:-} ]]; then
  [[ -x "$HAPPY" ]] || { echo "HAPPY is not executable: $HAPPY" >&2; exit 1; }
  PATH="$(dirname "$HAPPY"):$PATH"
elif ! command -v happy >/dev/null 2>&1; then
  echo "The native happy parser generator is required (tested with happy 2.1.7)." >&2
  echo "Install happy or set HAPPY=/absolute/path/to/happy." >&2
  exit 1
fi
export PATH

cd "$EXPERIMENT_DIR"

GHC_WASM_VERSION=$(wasm32-wasi-ghc --numeric-version)
export GHC_WASM_VERSION
STORE_PACKAGE_DB="$GHC_WASM_PREFIX/.cabal/store/ghc-${GHC_WASM_VERSION}-inplace/package.db"
PROJECT_PACKAGE_DB="$BUILD_DIR/packagedb/ghc-${GHC_WASM_VERSION}"
WASM_TOOLS="$GHC_WASM_PREFIX/wasmtime/bin/wasm-tools"

# Build the fork's complete Plinth plugin graph and its patched GHC driver.
wasm32-wasi-cabal \
  --project-file=cabal-9.12.project \
  --builddir="$BUILD_DIR" \
  build \
  lib:plinth-browser-utils \
  lib:plutarch-browser \
  lib:plutus-tx-plugin \
  exe:uplc-ghc-9-12

UPLC_GHC=$(wasm32-wasi-cabal \
  --project-file=cabal-9.12.project \
  --builddir="$BUILD_DIR" \
  list-bin exe:uplc-ghc-9-12)
install -m 0644 "$UPLC_GHC" "$EXPERIMENT_DIR/uplc-ghc.wasm"

# Build the browser-facing GHC API reactor used with GHC's dyld.mjs runtime.
wasm32-wasi-ghc -v0 -shared -dynamic -O1 \
  -package-db="$STORE_PACKAGE_DB" \
  -package-db="$PROJECT_PACKAGE_DB" \
  -package=ghc \
  -package=ghc-boot \
  -package=bytestring \
  -package=filepath \
  -package=text \
  -package=plutus-tx-plugin \
  -no-keep-hi-files \
  -no-keep-o-files \
  UplcGhcBrowser.hs \
  -o libuplc-ghc-browser.so

# Build an independent decoder used to validate the Flat output.
wasm32-wasi-ghc -v0 -O1 -hide-all-packages \
  -package=base \
  -package=bytestring \
  -package-id=plutus-core-1.66.0.0-inplace \
  -package-id=plutus-core-1.66.0.0-inplace-flat \
  -package-db="$STORE_PACKAGE_DB" \
  -package-db="$PROJECT_PACKAGE_DB" \
  -no-keep-hi-files \
  -no-keep-o-files \
  DecodeUplc.hs \
  -o decode-uplc.wasm

# Build the browser CEK runner. It decodes Flat UPLC, applies typed constants,
# and evaluates with Plinth's production CEK implementation and cost model.
wasm32-wasi-ghc -v0 -O1 -hide-all-packages \
  -package=base \
  -package=bytestring \
  -package=text \
  -package-id=plutus-core-1.66.0.0-inplace-satint \
  -package-id=plutus-core-1.66.0.0-inplace \
  -package-id=plutus-core-1.66.0.0-inplace-flat \
  -package-db="$STORE_PACKAGE_DB" \
  -package-db="$PROJECT_PACKAGE_DB" \
  -no-keep-hi-files \
  -no-keep-o-files \
  ../wasm/cek-evaluator/Main.hs \
  -o evaluate-uplc.wasm

# GHCi asks for two optional native libraries whose symbols this compile path
# never references. A symbol-free shared object satisfies those lookups.
wasm32-wasi-clang -shared -nostdlib -Wl,--no-entry \
  empty-wasi-shim.c \
  -o libuplc-ghc-empty.so

"$WASM_TOOLS" validate uplc-ghc.wasm
"$WASM_TOOLS" validate libuplc-ghc-browser.so
"$WASM_TOOLS" validate decode-uplc.wasm
"$WASM_TOOLS" validate evaluate-uplc.wasm
"$WASM_TOOLS" validate libuplc-ghc-empty.so

if [[ ${RUN_TESTS:-1} == 1 ]]; then
  bash "$EXPERIMENT_DIR/test-uplc-ghc-browser.sh"
fi

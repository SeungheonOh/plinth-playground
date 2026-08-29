#!/usr/bin/env bash
set -euo pipefail

EXPERIMENT_DIR=$(cd "$(dirname "$0")" && pwd)
GHC_WASM_PREFIX=${GHC_WASM_PREFIX:-"$EXPERIMENT_DIR/.compiler-deps/ghc-wasm"}

[[ -f "$GHC_WASM_PREFIX/env" ]] || {
  echo "Missing GHC WASM toolchain: $GHC_WASM_PREFIX" >&2
  exit 1
}

# shellcheck disable=SC1090
. "$GHC_WASM_PREFIX/env"
GHC_WASM_VERSION=${GHC_WASM_VERSION:-$(wasm32-wasi-ghc --numeric-version)}
WASM_RUN="$GHC_WASM_PREFIX/wasm-run/bin/wasm-run.mjs"
WASM_TOOLS="$GHC_WASM_PREFIX/wasmtime/bin/wasm-tools"

export GHC_WASM_PREFIX GHC_WASM_VERSION NODE_NO_WARNINGS=1
cd "$EXPERIMENT_DIR"

"$WASM_TOOLS" validate uplc-ghc.wasm
"$WASM_TOOLS" validate libuplc-ghc-browser.so
"$WASM_TOOLS" validate decode-uplc.wasm
"$WASM_TOOLS" validate evaluate-uplc.wasm
"$WASM_TOOLS" validate libuplc-ghc-empty.so

MAIN_RUN_OUTPUT=$(node test-uplc-ghc-browser.mjs)
case "$MAIN_RUN_OUTPUT" in
  *"BROWSER_MAIN_RAN"*) ;;
  *)
    echo "Main.main was not executed for the Plinth project:" >&2
    echo "$MAIN_RUN_OUTPUT" >&2
    exit 1
    ;;
esac
echo "$MAIN_RUN_OUTPUT"
DECODED=$(node "$WASM_RUN" decode-uplc.wasm BrowserPlinth.uplc-flat)

case "$DECODED" in
  *"(builtin addInteger)"*"(con integer 1)"*) ;;
  *)
    echo "Decoded output is not the expected addOne program:" >&2
    echo "$DECODED" >&2
    exit 1
    ;;
esac

echo "$DECODED"

BROWSER_SOURCE=BrowserPlinthWithUtils.hs \
BROWSER_EXTRA_ARGS=-package=plinth-browser-utils \
  node test-uplc-ghc-browser.mjs
DECODED_UTILS=$(node "$WASM_RUN" decode-uplc.wasm BrowserPlinth.uplc-flat)

case "$DECODED_UTILS" in
  *"(builtin addInteger)"*"(con integer 1)"*) ;;
  *)
    echo "Decoded output does not use the bundled Utils module:" >&2
    echo "$DECODED_UTILS" >&2
    exit 1
    ;;
esac

echo "$DECODED_UTILS"

BROWSER_SOURCE=BrowserPlinthMulti.hs \
BROWSER_EXTRA_SOURCES=LocalMath.hs=BrowserLocalMath.hs \
  node test-uplc-ghc-browser.mjs
DECODED_MULTI=$(node "$WASM_RUN" decode-uplc.wasm BrowserPlinth.uplc-flat)

case "$DECODED_MULTI" in
  *"(builtin addInteger)"*"(con integer 2)"*) ;;
  *)
    echo "Decoded multi-module output is not the expected addTwo program:" >&2
    echo "$DECODED_MULTI" >&2
    exit 1
    ;;
esac

echo "$DECODED_MULTI"

BROWSER_SOURCE=BrowserPlutarch.hs \
BROWSER_EXTRA_ARGS="-package-id=plutarch-1.12.0-inplace -package=plutarch-browser" \
  node test-uplc-ghc-browser.mjs
DECODED_PLUTARCH=$(node "$WASM_RUN" decode-uplc.wasm BrowserPlinth.uplc-flat)

case "$DECODED_PLUTARCH" in
  *"(builtin addInteger)"*"(con integer 1)"*) ;;
  *)
    echo "Decoded Plutarch output is not the expected successor program:" >&2
    echo "$DECODED_PLUTARCH" >&2
    exit 1
    ;;
esac

echo "$DECODED_PLUTARCH"

EVALUATED_PLUTARCH=$(node "$WASM_RUN" evaluate-uplc.wasm BrowserPlinth.uplc-flat integer:41)
case "$EVALUATED_PLUTARCH" in
  *$'RESULT\t28636f6e20696e746567657220343229'*) ;;
  *)
    echo "Plutarch successor did not evaluate to 42:" >&2
    echo "$EVALUATED_PLUTARCH" >&2
    exit 1
    ;;
esac

echo "$EVALUATED_PLUTARCH"

BROWSER_PROJECT_PAYLOAD=../app/example-projects.ts \
BROWSER_EXTRA_ARGS=-package-id=plutus-ledger-api-1.66.0.0-inplace \
  node test-uplc-ghc-browser.mjs
echo "Bundled two-party escrow example compiled successfully"

sha256sum BrowserPlinth.uplc-flat uplc-ghc.wasm libuplc-ghc-browser.so

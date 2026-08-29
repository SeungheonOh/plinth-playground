#!/usr/bin/env bash
set -euo pipefail

EXPERIMENT_DIR=$(cd "$(dirname "$0")" && pwd)
SITE_DIR=$(cd "$EXPERIMENT_DIR/.." && pwd)
GHC_WASM_PREFIX=${GHC_WASM_PREFIX:-"$EXPERIMENT_DIR/.compiler-deps/ghc-wasm"}
BUILD_TMP_DIR=${PLINTH_BUILD_TMP:-"$EXPERIMENT_DIR/.compiler-deps/tmp"}
PROJECT_DIR=${PLINTH_COMPILER_BUILD_DIR:-"$EXPERIMENT_DIR/dist-uplc-ghc-wasm-9.12"}

[[ -f "$GHC_WASM_PREFIX/env" ]] || {
  echo "Missing GHC WASM toolchain: $GHC_WASM_PREFIX" >&2
  echo "Run ./scripts/bootstrap-compiler.sh first." >&2
  exit 1
}

# shellcheck disable=SC1090
. "$GHC_WASM_PREFIX/env"
GHC_WASM_VERSION=${GHC_WASM_VERSION:-$(wasm32-wasi-ghc --numeric-version)}
GHC_LIBDIR="$GHC_WASM_PREFIX/wasm32-wasi-ghc/lib"
STORE_DIR="$GHC_WASM_PREFIX/.cabal/store/ghc-${GHC_WASM_VERSION}-inplace"
RUNTIME_DIR=${PLINTH_RUNTIME_DIR:-"$SITE_DIR/public/runtime"}
mkdir -p "$BUILD_TMP_DIR"
export TMPDIR="$BUILD_TMP_DIR"
STAGE_DIR=$(mktemp -d)

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

mkdir -p "$RUNTIME_DIR"

# Keep GHC's original absolute paths because Cabal package registrations are
# not relocatable. Strip static, profiling, documentation, and host JS assets.
GHC_STAGE="$STAGE_DIR${GHC_LIBDIR}"
mkdir -p "$GHC_STAGE"
rsync -a \
  --exclude='*.a' \
  --exclude='*.hi' \
  --exclude='*.p_hi' \
  --exclude='*.p_dyn_hi' \
  --exclude='*_p-*.so' \
  --exclude='*_debug*.so' \
  --exclude='doc/' \
  --exclude='html/' \
  --exclude='latex/' \
  --exclude='*.mjs' \
  --exclude='*.js' \
  --exclude='*.txt' \
  "$GHC_LIBDIR/" "$GHC_STAGE/"

# Cabal store: package registrations, dynamic interfaces, and shared objects.
STORE_STAGE="$STAGE_DIR${STORE_DIR}"
mkdir -p "$STORE_STAGE/package.db"
rsync -a "$STORE_DIR/package.db/" "$STORE_STAGE/package.db/"
rsync -a --prune-empty-dirs \
  --include='*/' \
  --include='*.dyn_hi' \
  --include='*.so' \
  --exclude='*' \
  "$STORE_DIR/" "$STORE_STAGE/"

# In-place Plinth packages use their build-tree paths in the package database.
PROJECT_STAGE="$STAGE_DIR${PROJECT_DIR}"
mkdir -p "$PROJECT_STAGE/packagedb/ghc-${GHC_WASM_VERSION}"
rsync -a \
  "$PROJECT_DIR/packagedb/ghc-${GHC_WASM_VERSION}/" \
  "$PROJECT_STAGE/packagedb/ghc-${GHC_WASM_VERSION}/"
rsync -a --prune-empty-dirs \
  --include='*/' \
  --include='*.dyn_hi' \
  --include='*.so' \
  --exclude='*' \
  "$PROJECT_DIR/" "$PROJECT_STAGE/"

# WASI C shared libraries and the browser compiler entry point.
mkdir -p "$STAGE_DIR/tmp/clib"
rsync -a --prune-empty-dirs \
  --include='*.so' \
  --exclude='libsetjmp.so' \
  --exclude='libwasi-emulated-*.so' \
  --exclude='*' \
  "$GHC_WASM_PREFIX/wasi-sdk/share/wasi-sysroot/lib/wasm32-wasi/" \
  "$STAGE_DIR/tmp/clib/"
cp "$EXPERIMENT_DIR/libuplc-ghc-empty.so" "$STAGE_DIR/tmp/clib/"
cp "$EXPERIMENT_DIR/libuplc-ghc-browser.so" "$STAGE_DIR/tmp/"

# Runtime JavaScript is served as ordinary static assets, outside the archive.
cp "$GHC_LIBDIR/dyld.mjs" "$RUNTIME_DIR/"
cp "$GHC_LIBDIR/post-link.mjs" "$RUNTIME_DIR/"
cp "$GHC_LIBDIR/prelude.mjs" "$RUNTIME_DIR/"
cp "$EXPERIMENT_DIR/decode-uplc.wasm" "$RUNTIME_DIR/"
cp "$EXPERIMENT_DIR/evaluate-uplc.wasm" "$RUNTIME_DIR/"

if [[ ! -s "$RUNTIME_DIR/bsdtar.wasm" ]]; then
  curl -fL \
    https://haskell-wasm.github.io/bsdtar-wasm/bsdtar.wasm \
    -o "$RUNTIME_DIR/bsdtar.wasm"
fi
printf '%s  %s\n' \
  e13ebb15ca0971f6629a6313bc043c532dd9be3a0e6bb0b7f8a395de835ad0c0 \
  "$RUNTIME_DIR/bsdtar.wasm" | sha256sum --check --status || {
    echo "bsdtar.wasm checksum mismatch" >&2
    exit 1
  }

tar -C "$STAGE_DIR" -cf - . | \
  pigz "-${GZIP_CLEVEL:-9}" > "$RUNTIME_DIR/rootfs.tar.gz"

node "$EXPERIMENT_DIR/split-rootfs.mjs" \
  "$RUNTIME_DIR/rootfs.tar.gz" \
  "$RUNTIME_DIR" \
  "${ROOTFS_PART_SIZE:-20971520}" \
  "$GHC_WASM_PREFIX" \
  "$GHC_WASM_VERSION" \
  "$PROJECT_DIR/packagedb/ghc-${GHC_WASM_VERSION}"

du -ch "$RUNTIME_DIR"/rootfs.part-* | tail -1

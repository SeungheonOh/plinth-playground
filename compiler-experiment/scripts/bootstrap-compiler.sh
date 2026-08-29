#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
COMPILER_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
DEPS_DIR=${PLINTH_COMPILER_DEPS:-"$COMPILER_DIR/.compiler-deps"}
TOOLCHAIN_DIR=${GHC_WASM_PREFIX:-"$DEPS_DIR/ghc-wasm"}
VENDOR_DIR="$DEPS_DIR/vendor"
DOWNLOAD_DIR="$DEPS_DIR/downloads"
PATCH_DIR="$COMPILER_DIR/patches"
BUILD_TMP_DIR=${PLINTH_BUILD_TMP:-"$DEPS_DIR/tmp"}

GHC_WASM_META_REV=8fd59591635cb47ad7db124562039bea8441cae8
GHC_WASM_VERSION=9.12.4.20260731
GHC_SOURCE_REV=b426432eec93dbad489e82287cb816bc23cdd8b4
GHC_MAIN_SHA256=236792060f81de1bacbdecc7d766e72a2ae85cce3a13b3f5f08e6b5d0fe4139a
GHCP_REV=c2d3bc3df6e2d018b57be9c87385f48d92b77d72
PLUTUS_REV=2e582ecde824238f927322d208740322eada8115
PLUTARCH_REV=011f6e18a2da94920cd009ce1970b43b18b70698
FOUNDATION_REV=8e6dd48527fb429c1922083a5030ef88e3d58dd3
NETWORK_REV=1dc870889eee4ac733335ced4e274b4dfe8ed369
CBORG_REV=6ef2791ca41b397a3e36c868ad3e66a0d09f19b2
LIBSODIUM_REV=985c18f75a71ff721370940666d71fda53edbb14
RAM_REV=335d2c2b58d6bce20d613aa4a5261227764d7f1c

export TMPDIR="$BUILD_TMP_DIR"
mkdir -p "$DEPS_DIR" "$VENDOR_DIR" "$DOWNLOAD_DIR" "$BUILD_TMP_DIR"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

for command_name in autoreconf curl git jq patch sha256sum tar unzip xz zstd; do
  require_command "$command_name"
done

clone_pinned() {
  local repository_url=$1
  local revision=$2
  local destination=$3

  if [[ ! -d "$destination/.git" ]]; then
    [[ ! -e "$destination" ]] || fail "$destination exists but is not a Git checkout"
    mkdir -p "$destination"
    git -C "$destination" init --quiet
    git -C "$destination" remote add origin "$repository_url"
    git -C "$destination" fetch --depth=1 origin "$revision"
    git -C "$destination" checkout --quiet --detach FETCH_HEAD
  fi

  local actual_revision
  actual_revision=$(git -C "$destination" rev-parse HEAD)
  [[ "$actual_revision" == "$revision" ]] ||
    fail "$destination is at $actual_revision; expected $revision"
}

fetch_parent_metadata() {
  local destination="$DEPS_DIR/ghc-plinth-parent"
  local parent_ref=refs/plinth-build/parent

  if [[ ! -d "$destination/.git" ]]; then
    [[ ! -e "$destination" ]] || fail "$destination exists but is not a Git checkout"
    mkdir -p "$destination"
    git -C "$destination" init --quiet
    git -C "$destination" remote add origin \
      https://github.com/input-output-hk/ghc-plinth.git
  fi
  if ! git -C "$destination" rev-parse --verify --quiet "$parent_ref" \
      >/dev/null; then
    git -C "$destination" fetch \
      --depth=1 \
      --filter=blob:none \
      origin \
      "$GHCP_REV:$parent_ref"
  fi

  local actual_parent mode object_type submodule_revision submodule_path
  actual_parent=$(git -C "$destination" rev-parse "$parent_ref")
  [[ "$actual_parent" == "$GHCP_REV" ]] ||
    fail "ghc-plinth metadata is at $actual_parent; expected $GHCP_REV"
  read -r mode object_type submodule_revision submodule_path < <(
    git -C "$destination" ls-tree "$parent_ref" plutus
  )
  [[ "$mode" == 160000 && "$object_type" == commit && \
      "$submodule_path" == plutus && "$submodule_revision" == "$PLUTUS_REV" ]] ||
    fail "ghc-plinth parent does not pin the expected Plinth submodule revision"
}

apply_git_patch() {
  local checkout=$1
  local patch_file=$2

  if git -C "$checkout" apply --check "$patch_file" >/dev/null 2>&1; then
    git -C "$checkout" apply "$patch_file"
  elif git -C "$checkout" apply --reverse --check "$patch_file" >/dev/null 2>&1; then
    printf 'already patched: %s\n' "$(basename "$patch_file")"
  else
    fail "cannot apply $(basename "$patch_file") in $checkout"
  fi
}

apply_plain_patch() {
  local source_directory=$1
  local patch_file=$2

  if patch --batch --forward --dry-run --silent -d "$source_directory" -p1 < "$patch_file" \
      >/dev/null 2>&1; then
    patch --batch --forward --silent -d "$source_directory" -p1 < "$patch_file"
  elif patch --batch --reverse --dry-run --silent -d "$source_directory" -p1 < "$patch_file" \
      >/dev/null 2>&1; then
    printf 'already patched: %s\n' "$(basename "$patch_file")"
  else
    fail "cannot apply $(basename "$patch_file") in $source_directory"
  fi
}

download_checked() {
  local url=$1
  local sha256=$2
  local destination=$3

  if [[ ! -f "$destination" ]]; then
    curl --fail --location --retry 5 "$url" --output "$destination"
  fi
  printf '%s  %s\n' "$sha256" "$destination" | sha256sum --check --status ||
    fail "checksum mismatch: $destination"
}

unpack_hackage() {
  local package=$1
  local sha256=$2
  local destination="$VENDOR_DIR/$package"
  local archive="$DOWNLOAD_DIR/$package.tar.gz"

  download_checked \
    "https://hackage.haskell.org/package/$package/$package.tar.gz" \
    "$sha256" \
    "$archive"
  PACKAGE_WAS_UNPACKED=0
  if [[ ! -d "$destination" ]]; then
    tar -xzf "$archive" -C "$VENDOR_DIR"
    PACKAGE_WAS_UNPACKED=1
  fi
}

install_toolchain() {
  if [[ -x "$TOOLCHAIN_DIR/wasm32-wasi-ghc/bin/wasm32-wasi-ghc" ]]; then
    return
  fi
  [[ ${PLINTH_SKIP_TOOLCHAIN:-0} != 1 ]] ||
    fail "PLINTH_SKIP_TOOLCHAIN=1 but no toolchain exists at $TOOLCHAIN_DIR"
  [[ ! -e "$TOOLCHAIN_DIR" ]] ||
    fail "$TOOLCHAIN_DIR exists but does not contain a complete GHC WASM toolchain"

  local meta_checkout="$DEPS_DIR/ghc-wasm-meta"
  clone_pinned \
    https://gitlab.haskell.org/ghc/ghc-wasm-meta.git \
    "$GHC_WASM_META_REV" \
    "$meta_checkout"
  PREFIX="$TOOLCHAIN_DIR" FLAVOUR=9.12 "$meta_checkout/setup.sh"
}

install_toolchain

# shellcheck disable=SC1090
. "$TOOLCHAIN_DIR/env"

actual_ghc_version=$(wasm32-wasi-ghc --numeric-version)
[[ "$actual_ghc_version" == "$GHC_WASM_VERSION" ]] ||
  fail "wasm32-wasi-ghc is $actual_ghc_version; expected $GHC_WASM_VERSION"

fetch_parent_metadata
clone_pinned \
  https://github.com/input-output-hk/ghc-plinth-plutus.git \
  "$PLUTUS_REV" \
  "$DEPS_DIR/plutus"
apply_git_patch "$DEPS_DIR/plutus" "$PATCH_DIR/plutus-dump-close.patch"

clone_pinned \
  https://github.com/SeungheonOh/plutarch-plutus.git \
  "$PLUTARCH_REV" \
  "$DEPS_DIR/plutarch-comparison"

clone_pinned \
  https://github.com/haskell-wasm/foundation.git \
  "$FOUNDATION_REV" \
  "$VENDOR_DIR/foundation"
clone_pinned \
  https://github.com/haskell-wasm/network.git \
  "$NETWORK_REV" \
  "$VENDOR_DIR/network"
if [[ ! -x "$VENDOR_DIR/network/configure" ]]; then
  (cd "$VENDOR_DIR/network" && autoreconf --force --install)
fi
clone_pinned \
  https://github.com/well-typed/cborg.git \
  "$CBORG_REV" \
  "$VENDOR_DIR/cborg"
clone_pinned \
  https://github.com/haskell-cryptography/libsodium-clib.git \
  "$LIBSODIUM_REV" \
  "$VENDOR_DIR/libsodium-clib"
apply_git_patch "$VENDOR_DIR/libsodium-clib" "$PATCH_DIR/libsodium-wasi.patch"
clone_pinned \
  https://github.com/jappeace/ram.git \
  "$RAM_REV" \
  "$VENDOR_DIR/ram"
apply_git_patch "$VENDOR_DIR/ram" "$PATCH_DIR/ram-wasi.patch"

unpack_hackage cryptonite-0.30 \
  56099c8a8aa01d2ee914b670c97c1f818186dbb886e2025b73d9c2afe3496b1d
apply_plain_patch "$VENDOR_DIR/cryptonite-0.30" "$PATCH_DIR/cryptonite-wasi.patch"

unpack_hackage crypton-1.1.4 \
  71029498ab3f83992532861d7e0b45672f5b02ea6e6c3d34b1afcd37e3e0ae67
apply_plain_patch "$VENDOR_DIR/crypton-1.1.4" "$PATCH_DIR/crypton-wasi.patch"

unpack_hackage double-conversion-2.0.5.0 \
  98c699b6e47b257dff85d49d59e39858462598008e074460c8bfacaa3e2a43ba
apply_plain_patch \
  "$VENDOR_DIR/double-conversion-2.0.5.0" \
  "$PATCH_DIR/double-conversion-wasi.patch"

unpack_hackage memory-0.18.0 \
  fd4eb6f638e24b81b4e6cdd68772a531726f2f67686c8969d3407d82f7862e3e
memory_cabal="$VENDOR_DIR/memory-0.18.0/memory.cabal"
download_checked \
  https://hackage.haskell.org/package/memory-0.18.0/revision/1.cabal \
  9f4de967352f80b6f174c9a166f315393dde80b77d7b67e41268ae7dec0319f9 \
  "$DOWNLOAD_DIR/memory-0.18.0-revision-1.cabal"
if [[ $PACKAGE_WAS_UNPACKED == 1 ]]; then
  install -m 0644 "$DOWNLOAD_DIR/memory-0.18.0-revision-1.cabal" "$memory_cabal"
fi
apply_plain_patch "$VENDOR_DIR/memory-0.18.0" "$PATCH_DIR/memory-wasi.patch"

ghc_main_download="$DOWNLOAD_DIR/ghc-Main-$GHC_SOURCE_REV.hs"
ghc_main_source="$DEPS_DIR/ghc-source/ghc/Main.hs"
mkdir -p "$(dirname "$ghc_main_source")"
download_checked \
  "https://gitlab.haskell.org/haskell-wasm/ghc/-/raw/$GHC_SOURCE_REV/ghc/Main.hs" \
  "$GHC_MAIN_SHA256" \
  "$ghc_main_download"
if [[ ! -f "$ghc_main_source" ]]; then
  install -m 0644 "$ghc_main_download" "$ghc_main_source"
fi
apply_plain_patch "$DEPS_DIR/ghc-source" "$PATCH_DIR/ghc-main-plinth.patch"
install -m 0644 \
  "$ghc_main_source" \
  "$COMPILER_DIR/uplc-ghc-wasm-9.12/src/Main.hs"

printf '%s\n' \
  "Prepared compiler sources and WASI dependencies." \
  "ghc-plinth parent revision: $GHCP_REV" \
  "Plinth submodule revision:  $PLUTUS_REV" \
  "Plutarch comparison fork:  $PLUTARCH_REV" \
  "GHC WASM version:           $actual_ghc_version" \
  "Toolchain:                  $TOOLCHAIN_DIR" \
  "Dependencies:               $DEPS_DIR"

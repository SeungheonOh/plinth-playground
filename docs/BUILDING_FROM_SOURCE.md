# Building the browser Plinth compiler from source

This document describes how to recreate every generated compiler asset used by
Plinth Playground. The build does not download a precompiled `uplc-ghc` binary
from this project. It builds the real Plinth 1.66 compiler plugin, a GHC driver,
the browser compiler reactor, the Flat decoder, and the CEK evaluator for
`wasm32-wasi`.

The checked-in files under `public/runtime` let ordinary web contributors run
and deploy the site without rebuilding GHC. Follow this guide when changing the
compiler, updating Plinth, auditing the binary provenance, or recreating the
runtime from a clean clone.

## Supported build host

The reproducible path is tested on 64-bit Linux. The pinned GHC WASM installer
also supports macOS and Linux on ARM64, but the complete Plinth dependency graph
has not been acceptance-tested on every host.

Allow approximately:

- 16 GB RAM; 32 GB is more comfortable during the Cabal build;
- 30–50 GB free disk space for the toolchain, Cabal store, sources, and build
  tree;
- 140 MB for the final compressed browser filesystem;
- 30–120 minutes for a cold build, depending on CPU and network speed.

Install these host tools:

```text
bash, autoconf, automake, curl, git, jq, patch, rsync, pigz, sha256sum, tar,
unzip, xz, zstd
Node.js, npm, and a native happy executable
```

On Debian or Ubuntu, the non-Haskell tools can be installed with:

```sh
sudo apt-get update
sudo apt-get install -y \
  autoconf automake build-essential curl git jq patch pigz rsync tar unzip \
  xz-utils zstd
```

The Plinth parser generation step needs a native `happy` executable. Version
2.1.7 is known to work. Install it with your normal Haskell toolchain, or enter
a Nix shell:

```sh
nix shell nixpkgs#happy
```

If `happy` is not on `PATH`, pass its absolute path with `HAPPY`.

## One-command build

From a clean checkout:

```sh
git clone https://github.com/SeungheonOh/plinth-playground.git
cd plinth-playground
HAPPY="$(command -v happy)" ./scripts/build-from-source.sh
```

The script performs these operations in order:

1. installs the pinned GHC 9.12 WASM toolchain;
2. verifies the `ghc-plinth` parent commit and fetches its pinned Plinth
   submodule plus the WASI-compatible dependency sources;
3. verifies downloaded Hackage tarballs by SHA-256;
4. applies the repository's small WASI compatibility patches;
5. builds the actual `uplc-ghc` driver and browser compiler reactor;
6. builds and validates the Flat decoder and CEK evaluator;
7. runs single-module, packaged-module, and multi-module compiler tests;
8. creates the stripped browser filesystem and splits it into 20 MiB assets;
9. installs JavaScript dependencies, lints the application, and builds the
   production website.

Generated dependency sources live under
`compiler-experiment/.compiler-deps`. They are ignored by Git. Compiler build
products live under `compiler-experiment/dist-uplc-ghc-wasm-9.12`, and the
deployable browser files are written to `public/runtime`.

To build only the compiler and browser runtime after bootstrapping:

```sh
npm run compiler:build
```

To prepare sources without compiling them:

```sh
npm run compiler:bootstrap
```

To skip the application build while regenerating the compiler:

```sh
BUILD_WEB_APP=0 ./scripts/build-from-source.sh
```

To skip the compiler acceptance tests during iteration:

```sh
RUN_TESTS=0 BUILD_WEB_APP=0 ./scripts/build-from-source.sh
```

Do not skip the tests for a runtime that will be committed or deployed.

## Pinned source inputs

The bootstrap script intentionally uses immutable revisions rather than moving
branches.

| Component | Upstream | Revision |
| --- | --- | --- |
| `ghc-plinth` parent | `input-output-hk/ghc-plinth` | `c2d3bc3df6e2d018b57be9c87385f48d92b77d72` |
| Plinth source submodule | `input-output-hk/ghc-plinth-plutus` | `2e582ecde824238f927322d208740322eada8115` |
| GHC WASM meta installer | `ghc/ghc-wasm-meta` | `8fd59591635cb47ad7db124562039bea8441cae8` |
| GHC 9.12 WASM source | `haskell-wasm/ghc` | `b426432eec93dbad489e82287cb816bc23cdd8b4` |
| `foundation` WASI port | `haskell-wasm/foundation` | `8e6dd48527fb429c1922083a5030ef88e3d58dd3` |
| `network` WASI port | `haskell-wasm/network` | `1dc870889eee4ac733335ced4e274b4dfe8ed369` |
| `cborg` | `well-typed/cborg` | `6ef2791ca41b397a3e36c868ad3e66a0d09f19b2` |
| `libsodium-clib` | `haskell-cryptography/libsodium-clib` | `985c18f75a71ff721370940666d71fda53edbb14` |
| `ram` | `jappeace/ram` | `335d2c2b58d6bce20d613aa4a5261227764d7f1c` |

The GHC WASM meta revision installs GHC
`9.12.4.20260731`. Hackage sources for `crypton-1.1.4`,
`double-conversion-2.0.5.0`, and `memory-0.18.0` are downloaded from canonical
package URLs and checked against hashes embedded in the bootstrap script.

The parent `ghc-plinth` repository is fetched as a blobless metadata checkout,
and the bootstrap verifies that its `plutus` gitlink is exactly the Plinth
revision above. The browser cannot use the parent's native GHC 9.6 backend, so
the same plugin source is linked into the pinned WASM-capable GHC 9.12 driver.

The Cabal solver is pinned to the repository/index state in
`compiler-experiment/cabal-9.12.project`. Git source dependencies in that file
also use immutable commits.

## Why the patches exist

All local changes to upstream source are stored in
`compiler-experiment/patches` and applied idempotently by the bootstrap script.

| Patch | Purpose |
| --- | --- |
| `ghc-main-plinth.patch` | Statically registers `Plinth.Plugin` in the GHC command-line driver. A browser cannot discover and load an arbitrary native plugin DLL. |
| `plutus-dump-close.patch` | Closes Flat dump handles before the browser wrapper immediately reads the generated file. |
| `libsodium-wasi.patch` | Uses the package version required by Plinth and disables an unavailable WASI system header. |
| `ram-wasi.patch` | Selects little-endian WASI and links the emulated `mman` library. |
| `crypton-wasi.patch` | Disables Argon2 threads, which are unavailable in this WASI runtime. |
| `double-conversion-wasi.patch` | Selects the IEEE-754 implementation path for `wasm32`. |
| `memory-wasi.patch` | Fixes 32-bit GHC primitives, C FFI return types, endianness, and emulated `mman` linkage. |

The browser-facing compiler itself is
`compiler-experiment/UplcGhcBrowser.hs`. It creates fresh GHC sessions,
registers the plugin statically, compiles support modules into a temporary
dynamic package, compiles `Main.hs`, and returns every emitted Flat UPLC file
as hexadecimal bytes. Dynamic interfaces are mandatory because the stripped
browser filesystem contains `.dyn_hi` files and shared libraries, not static
`.hi`/`.a` artifacts. Support modules use GHC's interpreter backend and `-O1`
so their dynamic interfaces retain the unfoldings that Plinth needs when
compiling imports from `Main.hs`.

## Build products

`compiler-experiment/build-uplc-ghc-wasm.sh` creates:

| Artifact | Role |
| --- | --- |
| `uplc-ghc.wasm` | Complete GHC command-line driver with the real Plinth plugin linked in. It is retained as an auditable standalone build product. |
| `libuplc-ghc-browser.so` | Dynamically linked GHC reactor loaded by `dyld.mjs` in the Web Worker. This is the compiler the website invokes. |
| `decode-uplc.wasm` | Independent decoder for Flat-encoded UPLC. |
| `evaluate-uplc.wasm` | Plinth's CEK evaluator with typed argument application, traces, and a restricting budget. |
| `libuplc-ghc-empty.so` | Empty shared-object shim for optional native libraries probed by GHCi but unused by this path. |

The browser reactor is a WASM shared object instead of an ordinary `_start`
program because Template Haskell and GHCi use the GHC WASM dynamic linker. That
runtime can suspend JavaScript FFI calls and load package shared objects while
the compiler remains alive across multiple requests.

## Browser filesystem packaging

`compiler-experiment/build-browser-rootfs.sh` stages only the runtime material
needed by GHC:

- package registrations;
- dynamic interface files (`.dyn_hi`);
- package shared objects (`.so`);
- GHC's JavaScript dynamic-linker support;
- the browser compiler reactor and optional-library shim.

Static archives, static interfaces, profiling libraries, documentation, and
host JavaScript files are excluded. The staged tree preserves its original
absolute paths because Cabal package registrations contain absolute import and
library directories.

The path is not assumed by the application. `rootfs-manifest.json` records:

- the GHC installation prefix;
- the exact GHC version;
- the Plinth project package database path;
- archive size, content version, and chunk list.

The Web Worker reads that metadata after downloading the manifest, creates the
same paths in its in-memory filesystem, and starts GHC with the recorded package
databases. This is what allows the repository to be built from an arbitrary
checkout directory.

The gzip archive is split into 20 MiB files so each asset remains below common
Git-hosting and Cloudflare upload limits. The original archive is deleted after
splitting.

## Acceptance tests

The default compiler build runs
`compiler-experiment/test-uplc-ghc-browser.sh`. It validates all WASM binaries,
loads the reactor through GHC's actual `dyld.mjs`, and checks:

1. a single `Main.hs` using `$$(PlutusTx.compile ...)`;
2. a program importing the packaged browser `Utils` module;
3. a two-file project whose `Main.hs` imports a Plinth function from a support
   module.

The resulting Flat programs are decoded with the independently built Plinth
decoder and checked for their expected `addInteger` constants.

After rebuilding the root filesystem, run the website and compile both the
default and multi-module examples in a real browser:

```sh
npm run dev
```

The first load downloads roughly 140 MB. Use the browser network panel to
confirm that all `rootfs.part-*` requests succeed and that the worker reaches
“Plinth compiler ready.”

## Using an existing toolchain or alternate directories

The scripts accept these environment variables:

| Variable | Meaning |
| --- | --- |
| `GHC_WASM_PREFIX` | Existing or desired GHC WASM installation prefix. |
| `PLINTH_COMPILER_DEPS` | Dependency checkout root. |
| `PLINTH_COMPILER_BUILD_DIR` | Cabal build directory. |
| `PLINTH_BUILD_TMP` | Temporary directory; use a disk-backed path if `/tmp` has a small quota. |
| `PLINTH_RUNTIME_DIR` | Runtime output directory; defaults to `public/runtime`. |
| `HAPPY` | Absolute path to a native `happy` executable. |
| `PLINTH_SKIP_TOOLCHAIN=1` | Require an existing toolchain instead of installing one. |
| `RUN_TESTS=0` | Skip compiler acceptance tests. |
| `BUILD_WEB_APP=0` | Skip npm install/lint/production build. |
| `ROOTFS_PART_SIZE` | Rootfs chunk size in bytes; defaults to 20 MiB. |
| `GZIP_CLEVEL` | `pigz` compression level; defaults to 9. |

Example using a disk-backed temporary area and an existing toolchain:

```sh
GHC_WASM_PREFIX=/work/ghc-wasm \
PLINTH_SKIP_TOOLCHAIN=1 \
PLINTH_BUILD_TMP=/work/plinth-tmp \
HAPPY=/usr/local/bin/happy \
./scripts/build-from-source.sh
```

## Clean rebuild

The following directories contain generated state and may be moved aside before
a completely cold rebuild:

```text
compiler-experiment/.compiler-deps
compiler-experiment/dist-uplc-ghc-wasm-9.12
```

Do not remove `public/runtime` unless you are immediately rebuilding it: the web
application needs those checked-in assets to start the compiler.

## Troubleshooting

### `happy: command not found`

Install native Happy 2.1.7 or set `HAPPY` to its absolute executable path. Do
not point `HAPPY` at a `wasm32-wasi` executable; Cabal must run it on the build
host.

### `Quota exceeded` under `/tmp`

GHC creates large temporary assembler and linker files. Select a disk-backed
directory:

```sh
PLINTH_BUILD_TMP=/path/with/free/space ./scripts/build-from-source.sh
```

### `Could not load module Prelude` or missing Plinth package files

The browser rootfs contains dynamic interfaces only. Ensure the current reactor
forces `-dynamic`, regenerate `public/runtime`, and verify that the new manifest
contains a `compiler` object. A manifest/runtime mismatch can point GHC at a
package database that does not exist in the in-memory filesystem.

### `Plinth produced no Flat UPLC output`

`$$(PlutusTx.compile ...)` must survive GHC optimization. Reference the compiled
binding from `main` or export it. For larger definitions across module
boundaries, add `INLINABLE` when GHC does not otherwise retain an unfolding;
this matches normal Plinth library usage.

### Cloudflare deployment

Rebuilding the compiler is separate from deployment. Once `public/runtime` and
the web build pass locally, use the normal deployment instructions in the root
README. CI deploys the checked-in runtime; it does not perform the multi-gigabyte
GHC/Plinth source build on every push.

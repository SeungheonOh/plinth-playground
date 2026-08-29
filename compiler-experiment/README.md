# Actual `uplc-ghc` compiled to WebAssembly

This directory contains the source-build pipeline for the real Plinth 1.66
compiler from `input-output-hk/ghc-plinth`, branch `ghc-9.6-plinth`. There is no
mock compiler or server fallback.

Start from the repository root:

```sh
./scripts/build-from-source.sh
```

For prerequisites, pinned revisions, patch rationale, architecture, artifact
descriptions, acceptance tests, configuration, and troubleshooting, read
[`docs/BUILDING_FROM_SOURCE.md`](../docs/BUILDING_FROM_SOURCE.md).

The low-level commands are:

```sh
./scripts/bootstrap-compiler.sh
./build-uplc-ghc-wasm.sh
./build-browser-rootfs.sh
```

`bootstrap-compiler.sh` installs the pinned GHC 9.12 WASM toolchain under
`.compiler-deps`, fetches verified source inputs, applies the tracked patches,
and materializes the patched GHC driver source. The build script compiles and
tests the driver, browser reactor, decoder, evaluator, and optional-library
shim. The rootfs script strips static build material and writes the deployable
chunked runtime to `../public/runtime`.

The runtime also includes Plutarch 1.12.0 from the comparison repository's
pinned `SeungheonOh/plutarch-plutus` compatibility fork. Browser projects can
export a locally defined Plutarch term by calling
`Plutarch.Browser.exportScript` from `main`:

```haskell
successor :: Term s (PInteger :--> PInteger)
successor = plam $ \value -> value + 1

main :: IO ()
main = exportScript "successor" $ compile mempty successor
```

The helper serializes the compiled Plutarch `Script` to Flat UPLC, which is
then decoded and evaluated by the same in-browser CEK machine as Plinth output.
The browser compiler runs `Main.main` after every successful build, including
ordinary Plinth projects.

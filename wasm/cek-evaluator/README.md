# Browser CEK evaluator

`Main.hs` is the source of `public/runtime/evaluate-uplc.wasm`. It links the
Plinth 1.66 `plutus-core` CEK machine into a standalone WASI command. The
browser worker passes a Flat UPLC file plus typed arguments, then parses the
machine-readable result, execution budget, and trace records.

Evaluation uses Plinth's default cost model and a 15 billion CPU / 40 million
memory budget ceiling so a nonterminating program cannot run without a bound.

The module is built by the local compiler toolchain in `compiler-experiment`.
Its `build-uplc-ghc-wasm.sh` command produces and validates
`evaluate-uplc.wasm`; copy that generated artifact into `public/runtime`
before building the web application.

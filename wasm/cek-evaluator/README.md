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

`BrowserDebugger.hs` is built into `libuplc-ghc-browser.so`, not into the
one-shot evaluator command. `uplcCekDebugger` returns a persistent command
function backed by upstream `SteppableCek.mkCekTrans` and `SrcSpans` annotations.
Start/step/inspect/stop operate on that single machine instance. The adapter
checks annotated/ordinary Flat equality, charges startup once, uses immediate
budget accounting, and exposes lazy state-scoped references for complete value,
closure, and environment inspection. All worker requests are serialized.
Both evaluators share `CekArguments.hs` for typed-argument parsing.

Native smoke/regression check (after building the reactor):

```sh
cd compiler-experiment
BROWSER_DEBUG_TEST=1 node test-uplc-ghc-browser.mjs
```

The default fixture checks an exact variable-use span, not just a definition
span. Full browser differential tests run with `npm run test:debugger:browser`.

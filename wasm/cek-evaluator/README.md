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
BROWSER_DEBUG_TEST=1 BROWSER_REVERSE_TEST=1 node test-uplc-ghc-browser.mjs
```

The default fixture checks an exact variable-use span, not just a definition
span. The reverse test compares every restored state with the original forward
run. History holds immutable CEK states and snapshots of budget/trace values;
the upstream machine's mutable budget refs stay at the execution frontier.
Full browser differential tests run with `npm run test:debugger:browser`.

Known annotation limitation: `Plinth.+` becomes an unannotated `addInteger`
builtin in the pinned compiler. To reproduce this separately from history
tests, run `BROWSER_DEBUG_TEST=1 BROWSER_OPERATOR_TEST=1 node
--experimental-strip-types test-uplc-ghc-browser.mjs`. This diagnostic currently
fails deliberately on the missing operator highlight and prints the actual
per-step annotations, using the same source-selection code as the UI.

The debugger enriches annotations at session startup without altering UPLC
terms or CEK rules. Each node keeps its original spans plus the spans introduced
relative to its parent, so a recursive use is focused instead of an inherited
definition. Lexical UPLC binder names travel with the annotations and label
active, saved, and captured environments at their actual de Bruijn indices.
Generated names remain generated names; this does not invent a Haskell call
stack or recover optimized-away source expressions. All original spans remain
available as secondary locations.

Fibonacci regression test, from `compiler-experiment` with the toolchain set:

```sh
BROWSER_SOURCE=BrowserFibonacci.hs BROWSER_DEBUG_TEST=1 \
  BROWSER_DEBUG_ARGS='["integer:3"]' BROWSER_DEBUG_LIMIT=2000 \
  BROWSER_CALL_SITE_TEST=1 BROWSER_DEBUG_TRACE=/tmp/plinth-fibonacci-trace.json \
  node test-uplc-ghc-browser.mjs
```

This checks both recursive calls, named bindings, and Next source stops. The
optional trace contains actual states, inspected control/environments/frame
fields, and the frontend-selected source range. Add `BROWSER_REVERSE_TEST=1`
for exact history replay. The browser suite also checks the selectable example,
call highlights, visible frame summaries and responsive layout. Do not use the
default test-harness argument of 41 with Fibonacci (the UI example defaults to 5).

# Plinth Playground

[![CI and deploy](https://github.com/SeungheonOh/plinth-playground/actions/workflows/deploy.yml/badge.svg?branch=master)](https://github.com/SeungheonOh/plinth-playground/actions/workflows/deploy.yml)

A browser-hosted Plinth and Plutarch compiler and evaluator. It runs the real
GHC, Plinth, and Plutarch toolchain in a Web Worker, displays the generated
Untyped Plutus Core and Flat bytes, and evaluates the result with Plinth's CEK
machine compiled to WASI.
Compilation and execution happen locally in the browser; there is no compiler
or evaluator API server.

Projects can contain multiple Haskell modules. Add modules from the project
tree using names such as `Utils` or `Validators.Math`; the compiler builds them
inside WASM and makes them available to `Main.hs` through ordinary Haskell
imports. Functions used across module boundaries by compiled Plinth code must
have an exported unfolding. GHC usually exports small optimized functions;
mark larger Plinth helpers `INLINABLE`, as in a normal packaged library.

The Share button compresses every module and the current CEK arguments into the
URL fragment. Opening that URL restores the complete project without uploading
its source to a server.

The Run workspace can apply ordered Integer, ByteString, String, Bool, Unit,
and Plutus Data constants. It reports the reduced UPLC, execution budget, and
trace logs. CEK execution is budget-bounded so nonterminating programs cannot
run indefinitely.

The Plutarch example calls `Plutarch.Browser.exportScript` from `Main.main` to
export a locally defined typed term as Flat UPLC. Every successful project runs
`Main.main`; the output then follows the same decode, argument-application, and
CEK execution path as scripts emitted by the Plinth plugin.

## Optimization certificates

“Certify optimizations” is enabled by default. Compilation passes `certify` and
`certified-opts-only` to the bundled Plinth plugin, which runs its Agda-derived
certifier and emits an Agda project for each compiled Plinth expression.
The result panel shows the certifier outcome and a **Certificates .zip** download.
The ZIP includes the original generated projects, PASS/FAIL reports, Haskell
sources, Flat/text UPLC outputs, and a manifest of compiler flags and file hashes.
Artifacts are cleared before each compilation, including failed compilations.

Selecting certified passes can change script size and execution cost. Uncheck
the option to use the usual optimization pipeline. These certificates cover the
UPLC optimization trace, not the Haskell-to-PIR/PLC translation or contract
correctness. Plutarch exports are not covered by this Plinth plugin feature.
Per-module plugin options can override the build flags; a trace containing
unsupported passes is labeled partial even when the plugin's marker says PASS.

To independently type-check a downloaded project, follow its README using Agda
2.8.0, standard-library 2.3, and `plutus-metatheory` from the pinned Plutus revision
`2e582ecde824238f927322d208740322eada8115`. The playground runs the embedded
certifier but does not run this separate Agda type-checking step.

Run `npm run test:certificates` to check archive integrity and PASS/FAIL/partial
handling. With the app running locally and Chrome installed, the full WASM and
download check is:

```sh
CHROME_EXECUTABLE=/path/to/chrome PLINTH_URL=http://localhost:5174 npm run test:certificates:browser
```

It checks multiple modules and compile splices, a nontrivial optimization proof,
CEK execution, ZIP downloads, stale/failed-build handling, opting out, Plutarch
exports, and desktop/mobile layout.

## Source-level CEK debugger

Compile Plinth code, set arguments in **Run**, then open **Debug** and choose
**Start debugger**. **Step CEK** (F10) advances exactly one upstream steppable
CEK transition. **Next source** (F11) advances to a different mapped expression;
**Continue/Pause** (F8) runs bounded batches. Restart uses the same compiled
program and arguments. Toggle source-line breakpoints in the editor gutter or
the Breakpoints form. Source locations navigate between project modules.

**Back** (Shift+F10) restores the previous CEK state, including its budget,
traces, environment and continuation frames. It also works after completion or
failure. Every transition is retained, including those inside Continue/Next
source batches, within a rolling 10,000-transition window shown in the panel.
Back/forward navigation uses immutable native checkpoints, not re-execution.
The live machine remains at the furthest executed state; stepping beyond the
recorded history resumes it without duplicating traces or charging costs twice.

The inspector exposes the actual control term or returned value, all
continuation frames, saved/captured environments, constructor fields, partially
applied builtins, trace messages, and live used/remaining execution budget.
Environment names come from lexical binders in the compiled UPLC, with their
actual CEK de Bruijn indices (1 is newest). Generated names stay generated;
these are not reconstructed Haskell locals. Expand any value for its full contents;
large terms are collapsed for readability rather than discarded.
Bindings use aligned name/type/value columns, and numbered continuation cards
show pending expressions, partial builtin applications, and saved bindings even
while collapsed. The current action is displayed above the source location.
Expanded rows stay open while stepping, but their contents
are fetched from the current machine state. The two inspectors sit side by side
in wide panels and stack vertically in narrower panels.

The compiler enables Plinth's `preserve-source-locations` option and writes an
annotated `.uplc-flat.debug` sidecar alongside each ordinary Flat script.
Before execution, the debugger erases only the annotations and verifies that
the encoded term equals the original Flat bytes. It executes upstream
`SteppableCek.mkCekTrans` with enriched annotations retaining the original
`SrcSpans`, keeping the machine and budget refs
inside the existing WASM reactor between requests. It does not replay the
program or reconstruct source locations from text.

Highlighting uses the compiler's actual ranges. Optimization can merge/remove
expressions, and generated argument applications or unavailable library source
may have no project span. Such states remain inspectable and are explicitly
unmapped. This is debugging optimized UPLC, not a Haskell interpreter.
Spans introduced at a node take precedence over inherited enclosing-definition
spans; all original locations remain accessible. The **Fibonacci · recursive
debugger** example starts with argument 5 and demonstrates both recursive call
sites, named arguments, saved continuations, and backward stepping.
In particular, the pinned compiler currently emits the builtin for `Plinth.+`
without that operator's source span, even with Plinth optimization disabled.
Nearby variable-use spans do survive. The debugger cannot infer a trustworthy
operator location from an unannotated builtin; backward stepping does not fix
this compiler-side annotation limitation.
Plutarch `Main.main` exports do not include Plinth annotations and cannot use
this source debugger. Editing/recompiling, switching programs, changing
arguments, or leaving Debug discards the session; old value references cannot
be reused in a later state.

The debugger uses the same default cost model and 15 billion CPU / 40 million
memory limits as Run, with immediate accounting (`nilSlippage`). Successful
results, logs, and budgets are compared against the normal evaluator in browser
tests. On early failure, immediate accounting can include pending machine costs
that the normal evaluator has not yet charged in its batching optimization.

```sh
npm run test:debugger
CHROME_EXECUTABLE=/path/to/chrome PLINTH_URL=http://localhost:5174 npm run test:debugger:browser
```

The browser test exercises exact single steps, granular cross-module spans,
closure/stack inspection, both branches of a traced program, multiple compiled
expressions, validator failure, breakpoints, stale references, edits, persistent
expanded bindings, backward/forward state equality, history eviction, continuation
beyond the recorded frontier, and responsive column alignment.

## Local development

```sh
npm ci
npm run dev
```

The first browser load downloads roughly 185 MB of compiler files from
`public/runtime`. The 10 MB CEK evaluator is loaded lazily on the first run.
Compiler files are split into chunks small enough for normal Git and Cloudflare
asset uploads.

## Rebuilding the compiler from source

The repository includes pinned source revisions, WASI compatibility patches,
bootstrap scripts, compiler acceptance tests, and browser-filesystem packaging.
To recreate `uplc-ghc`, the browser reactor, Flat decoder, CEK evaluator, and
the complete website from a clean checkout, see
[Building the browser Plinth compiler from source](docs/BUILDING_FROM_SOURCE.md).

The complete entry point is:

```sh
HAPPY="$(command -v happy)" ./scripts/build-from-source.sh
```

Ordinary UI development does not require this expensive source build because
the generated runtime under `public/runtime` is checked in.

## Cloudflare deployment

The project uses the Cloudflare Vite plugin and `wrangler.jsonc`, following the
same deployment shape as the reference UPLC playground.

```sh
npm ci
npm run build
npx wrangler deploy --dry-run
npm run deploy
```

`npm run deploy` builds the app and deploys the generated Worker plus all static
compiler assets. Sign in with `npx wrangler login` first when running locally.

For Cloudflare Git Builds, use:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

## GitHub Actions deployment

Pushes to `master` are linted, built, and deployed automatically to
`https://plinth.isotopy.xyz`. Pull requests run the same checks and validate a
dry-run deployment without receiving production credentials.

The workflow expects these GitHub Actions secrets:

- Repository secret `CLOUDFLARE_ACCOUNT_ID`
- Production-environment secret `CLOUDFLARE_API_TOKEN`, scoped to this account with the **Edit Cloudflare Workers** template

To attach a custom domain, add a `routes` entry to `wrangler.jsonc` or configure
the domain in the Cloudflare dashboard.

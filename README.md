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

## Local development

```sh
npm ci
npm run dev
```

The first browser load downloads roughly 150 MB of compiler files from
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

# Plinth Playground

[![CI and deploy](https://github.com/SeungheonOh/plinth-playground/actions/workflows/deploy.yml/badge.svg?branch=master)](https://github.com/SeungheonOh/plinth-playground/actions/workflows/deploy.yml)

A browser-hosted Plinth compiler and evaluator. It runs the real GHC + Plinth
toolchain in a Web Worker, displays the generated Untyped Plutus Core and Flat
bytes, and evaluates the result with Plinth's CEK machine compiled to WASI.
Compilation and execution happen locally in the browser; there is no compiler
or evaluator API server.

Projects can contain multiple Haskell modules. Add modules from the file-tab
bar using names such as `Utils` or `Validators.Math`; the compiler builds them
inside WASM and makes them available to `Main.hs` through ordinary Haskell
imports. Functions used across module boundaries by compiled Plinth code must
be marked `INLINABLE`, as they would in a normal packaged Plinth library.

The Share button compresses every module and the current CEK arguments into the
URL fragment. Opening that URL restores the complete project without uploading
its source to a server.

The Run workspace can apply ordered Integer, ByteString, String, Bool, Unit,
and Plutus Data constants. It reports the reduced UPLC, execution budget, and
trace logs. CEK execution is budget-bounded so nonterminating programs cannot
run indefinitely.

## Local development

```sh
npm ci
npm run dev
```

The first browser load downloads roughly 140 MB of compiler files from
`public/runtime`. The 10 MB CEK evaluator is loaded lazily on the first run.
Compiler files are split into chunks small enough for normal Git and Cloudflare
asset uploads.

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
